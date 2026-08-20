import { openDatabase, closeDatabase } from './db/open.ts'
import { migrateToLatest } from './db/migrate.ts'
import { loadOrCreateKey } from './crypto/key.ts'
import { CredentialStore } from './store/credentials.ts'
import { RawArchive } from './store/rawArchive.ts'
import type { Database } from './db/open.ts'

export interface Instance {
  db: Database
  key: Buffer
  credentials: CredentialStore
  archive: RawArchive
  close: () => void
}

// Four ordered steps that every surface would otherwise repeat, each with its own chance to skip
// the migration or read the key from a different directory than the database.
export function openHaelan(dir: string, env: NodeJS.ProcessEnv = process.env): Instance {
  const db = openDatabase(dir)
  migrateToLatest(db)
  const key = loadOrCreateKey(dir, env)
  return {
    db,
    key,
    credentials: new CredentialStore(db, key),
    archive: new RawArchive(db),
    close: () => closeDatabase(db),
  }
}
