import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { openDatabase, closeDatabase } from '../src/db/open.ts'

describe('openDatabase', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'haelan-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates the database file inside the data directory', () => {
    const db = openDatabase(dir)
    expect(existsSync(join(dir, 'haelan.sqlite'))).toBe(true)
    closeDatabase(db)
  })

  it('runs in WAL mode so readers do not block the sync writer', () => {
    const db = openDatabase(dir)
    const [row] = db.all<{ journal_mode: string }>(sql`pragma journal_mode`)
    expect(row?.journal_mode).toBe('wal')
    closeDatabase(db)
  })

  it('enforces foreign keys', () => {
    const db = openDatabase(dir)
    const [row] = db.all<{ foreign_keys: number }>(sql`pragma foreign_keys`)
    expect(row?.foreign_keys).toBe(1)
    closeDatabase(db)
  })

  it('creates the directory when it does not exist yet', () => {
    const nested = join(dir, 'data')
    const db = openDatabase(nested)
    expect(existsSync(join(nested, 'haelan.sqlite'))).toBe(true)
    closeDatabase(db)
  })
})
