import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, closeDatabase, tableExists } from '../src/db/open.ts'
import { migrateToLatest } from '../src/db/migrate.ts'
import type { Database } from '../src/db/open.ts'

const TABLES = [
  'people', 'sources', 'oauth_client', 'credentials', 'notes', 'events', 'overrides',
  'raw_payloads', 'samples', 'sessions', 'session_segments', 'daily', 'sync_state',
]

describe('migrateToLatest', () => {
  let dir: string
  let db: Database

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'haelan-')); db = openDatabase(dir) })
  afterEach(() => { closeDatabase(db); rmSync(dir, { recursive: true, force: true }) })

  it('creates every table', () => {
    migrateToLatest(db)
    for (const table of TABLES) expect(tableExists(db, table), table).toBe(true)
  })

  it('is idempotent, because it runs on every boot', () => {
    migrateToLatest(db)
    expect(() => migrateToLatest(db)).not.toThrow()
    for (const table of TABLES) expect(tableExists(db, table), table).toBe(true)
  })
})
