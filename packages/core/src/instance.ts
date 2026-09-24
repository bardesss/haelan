import { openDatabase, closeDatabase, checkpointTruncate } from './db/open.ts'
import { migrateToLatest } from './db/migrate.ts'
import { loadOrCreateKey } from './crypto/key.ts'
import { CredentialStore } from './store/credentials.ts'
import { RawArchive } from './store/rawArchive.ts'
import { DeriveQueue } from './store/deriveQueue.ts'
import { SourcePriorityStore } from './store/sourcePriority.ts'
import { SourceAliasStore } from './store/sourceAliases.ts'
import { SourceVisibilityStore } from './store/sourceVisibility.ts'
import { ExcludedDataTypeStore } from './store/excludedDataTypes.ts'
import { OverrideStore } from './store/overrides.ts'
import { SettingsStore } from './store/settings.ts'
import { NoteStore } from './store/notes.ts'
import { EventStore } from './store/events.ts'
import { ObservationStore } from './store/observations.ts'
import { InviteStore } from './store/invites.ts'
import { RebuildStateStore } from './store/rebuildState.ts'
import type { Database } from './db/open.ts'

export interface Instance {
  db: Database
  key: Buffer
  credentials: CredentialStore
  archive: RawArchive
  deriveQueue: DeriveQueue
  sourcePriority: SourcePriorityStore
  sourceAliases: SourceAliasStore
  sourceVisibility: SourceVisibilityStore
  excludedDataTypes: ExcludedDataTypeStore
  overrides: OverrideStore
  notes: NoteStore
  events: EventStore
  observations: ObservationStore
  settings: SettingsStore
  invites: InviteStore
  rebuildState: RebuildStateStore
  close: () => void
}

// Four ordered steps that every surface would otherwise repeat, each with its own chance to skip
// the migration or read the key from a different directory than the database.
export function openHaelan(dir: string, env: NodeJS.ProcessEnv = process.env): Instance {
  const db = openDatabase(dir)
  try {
    migrateToLatest(db)
    // Covers any migration that rewrites rows in bulk, not just this one: 0015's
    // `UPDATE raw_payloads SET ref = rowid` touches every archived body in one transaction, which
    // is the same shape of WAL surprise checkpointTruncate exists for elsewhere (runRebuild). A
    // no-op once the log is already small, which is every boot after the first.
    checkpointTruncate(db)
    const key = loadOrCreateKey(dir, env)
    const deriveQueue = new DeriveQueue(db)
    return {
      db,
      key,
      credentials: new CredentialStore(db, key),
      archive: new RawArchive(db),
      deriveQueue,
      sourcePriority: new SourcePriorityStore(db, deriveQueue),
      sourceAliases: new SourceAliasStore(db),
      sourceVisibility: new SourceVisibilityStore(db),
      excludedDataTypes: new ExcludedDataTypeStore(db),
      overrides: new OverrideStore(db, deriveQueue),
      notes: new NoteStore(db),
      events: new EventStore(db),
      observations: new ObservationStore(db),
      settings: new SettingsStore(db),
      invites: new InviteStore(db),
      rebuildState: new RebuildStateStore(db),
      close: () => closeDatabase(db),
    }
  } catch (err) {
    // openDatabase already holds the file handle and WAL lock; a migration or key failure
    // here must not leave it open, or a later open of the same directory can block on Windows.
    closeDatabase(db)
    throw err
  }
}
