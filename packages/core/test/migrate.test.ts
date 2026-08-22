import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, closeDatabase, tableExists } from '../src/db/open.ts'
import { migrateToLatest } from '../src/db/migrate.ts'
import { createTestDatabase } from '../src/testing/fixtures.ts'
import type { Database } from '../src/db/open.ts'

const TABLES = [
  'people', 'sources', 'source_priority', 'oauth_client', 'credentials', 'notes', 'events',
  'overrides', 'raw_payloads', 'samples', 'sessions', 'session_segments', 'daily', 'sync_state',
  'derive_queue',
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

describe('migration 0001', () => {
  it('creates the three tables the setup wizard writes', () => {
    const { db, cleanup } = createTestDatabase()
    try {
      for (const name of ['accounts', 'auth_sessions', 'instance_settings']) {
        expect(tableExists(db, name), name).toBe(true)
      }
    } finally { cleanup() }
  })

  it('does not rename the tier 2 sessions table', () => {
    const { db, cleanup } = createTestDatabase()
    try {
      // auth_sessions is deliberately not called sessions: sleep and exercise already own
      // that name, and a collision here would be a schema bug that reads like a typo.
      expect(tableExists(db, 'sessions')).toBe(true)
      expect(tableExists(db, 'auth_sessions')).toBe(true)
    } finally { cleanup() }
  })
})
