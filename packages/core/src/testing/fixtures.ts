import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase } from '../db/open.ts'
import { migrateToLatest } from '../db/migrate.ts'
import { people, sources, samples } from '../db/schema/index.ts'
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

export interface DerivableDay { personId: string, localDate: string }

// One person, one source, one sample on one local date: the minimum a derivation needs to
// produce a row. Shared by tests that only need a day worth deriving and do not care what is
// in it, so a rebuild test and a queue drain test are not each inventing their own person.
export function seedDerivableDay(db: Database): DerivableDay {
  const personId = 'p1'
  const localDate = '2026-08-22'
  seedPerson(db, personId)
  db.insert(sources).values({
    id: 'watch', personId, externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).run()
  db.insert(samples).values({
    personId, sourceId: 'watch', metric: 'steps',
    utcMs: Date.parse(`${localDate}T09:00:00Z`), tzOffsetMinutes: 0,
    agg: 'raw', value: 400, n: 1, rawPayloadId: null,
  }).run()
  return { personId, localDate }
}
