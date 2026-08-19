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
  // Every later plan calls this in a beforeEach; a migration that throws must not leave a
  // dangling handle and temp dir behind for every test in the run.
  try {
    migrateToLatest(db)
  } catch (err) {
    closeDatabase(db)
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
  return { db, dir, cleanup: () => { closeDatabase(db); rmSync(dir, { recursive: true, force: true }) } }
}

export interface SeedPersonOverrides { timezone?: string, displayName?: string, createdAtMs?: number }

export function seedPerson(db: Database, id: string, overrides: SeedPersonOverrides = {}): string {
  db.insert(people).values({
    id,
    displayName: overrides.displayName ?? id,
    timezone: overrides.timezone ?? 'Europe/Amsterdam',
    createdAtMs: overrides.createdAtMs ?? 0,
  }).run()
  return id
}
