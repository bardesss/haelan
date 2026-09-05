import { openDatabase, closeDatabase } from './db/open.ts'
import { migrateToLatest } from './db/migrate.ts'
import { loadOrCreateKey } from './crypto/key.ts'
import { CredentialStore } from './store/credentials.ts'
import { RawArchive } from './store/rawArchive.ts'
import { DeriveQueue } from './store/deriveQueue.ts'
import { SourcePriorityStore } from './store/sourcePriority.ts'
import { SourceAliasStore } from './store/sourceAliases.ts'
import { OverrideStore } from './store/overrides.ts'
import { SettingsStore } from './store/settings.ts'
import { NoteStore } from './store/notes.ts'
import { EventStore } from './store/events.ts'
import { InviteStore } from './store/invites.ts'
import type { Database } from './db/open.ts'

export interface Instance {
  db: Database
  key: Buffer
  credentials: CredentialStore
  archive: RawArchive
  deriveQueue: DeriveQueue
  sourcePriority: SourcePriorityStore
  sourceAliases: SourceAliasStore
  overrides: OverrideStore
  notes: NoteStore
  events: EventStore
  settings: SettingsStore
  invites: InviteStore
  close: () => void
}

// Four ordered steps that every surface would otherwise repeat, each with its own chance to skip
// the migration or read the key from a different directory than the database.
export function openHaelan(dir: string, env: NodeJS.ProcessEnv = process.env): Instance {
  const db = openDatabase(dir)
  try {
    migrateToLatest(db)
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
      overrides: new OverrideStore(db, deriveQueue),
      notes: new NoteStore(db),
      events: new EventStore(db),
      settings: new SettingsStore(db),
      invites: new InviteStore(db),
      close: () => closeDatabase(db),
    }
  } catch (err) {
    // openDatabase already holds the file handle and WAL lock; a migration or key failure
    // here must not leave it open, or a later open of the same directory can block on Windows.
    closeDatabase(db)
    throw err
  }
}
