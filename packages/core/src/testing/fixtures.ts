import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase } from '../db/open.ts'
import { migrateToLatest } from '../db/migrate.ts'
import { people } from '../db/schema/index.ts'
import type { Database } from '../db/open.ts'

export interface TestDatabase { db: Database, dir: string, cleanup: () => void }

export function createTestDatabase(): TestDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-test-'))
  const db = openDatabase(dir)
  migrateToLatest(db)
  return { db, dir, cleanup: () => { closeDatabase(db); rmSync(dir, { recursive: true, force: true }) } }
}

export function seedPerson(db: Database, id: string, timezone = 'Europe/Amsterdam'): string {
  db.insert(people).values({ id, displayName: id, timezone, createdAtMs: 0 }).run()
  return id
}
