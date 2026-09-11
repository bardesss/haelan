import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import BetterSqlite3 from 'better-sqlite3'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { openReadOnly, latestMigrationWhen } from '../src/db/openReadOnly.ts'
import { closeDatabase, DATABASE_FILENAME } from '../src/db/open.ts'
import { ConfigError } from '../src/errors.ts'
import { people } from '../src/db/schema/index.ts'

let test: TestDatabase
// Only 'refuses a database that exists but was never migrated' sets this; left undefined for
// every other test, so cleanup here never touches a directory that test didn't create.
let bareDir: string | undefined
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1', { displayName: 'Robin' })
  bareDir = undefined
})
afterEach(() => {
  test.cleanup()
  if (bareDir !== undefined) rmSync(bareDir, { recursive: true, force: true })
})

describe('openReadOnly', () => {
  it('reads a migrated database without migrating it', () => {
    const db = openReadOnly(test.dir)
    try {
      expect(db.select().from(people).all().map((p) => p.displayName)).toEqual(['Robin'])
    } finally {
      closeDatabase(db)
    }
  })

  it('refuses to write', () => {
    const db = openReadOnly(test.dir)
    try {
      expect(() => db.insert(people).values({
        id: 'p2', displayName: 'Sam', timezone: 'Europe/Amsterdam', createdAtMs: 0,
      }).run()).toThrow(/readonly/i)
    } finally {
      closeDatabase(db)
    }
  })

  it('names the directory when there is no database in it', () => {
    expect(() => openReadOnly(`${test.dir}-empty`)).toThrow(ConfigError)
    expect(() => openReadOnly(`${test.dir}-empty`)).toThrow(/no haelan database/i)
  })

  it('refuses a database older than this build, naming both versions', () => {
    const newest = latestMigrationWhen()
    test.db.run(sql`delete from __drizzle_migrations where created_at = ${newest}`)
    expect(() => openReadOnly(test.dir)).toThrow(/older than this build/i)
  })

  it('refuses a database newer than this build, naming both versions', () => {
    const newest = latestMigrationWhen()
    test.db.run(sql`insert into __drizzle_migrations (hash, created_at) values ('future', ${newest + 1})`)
    expect(() => openReadOnly(test.dir)).toThrow(/newer than this build/i)
  })

  it('answers a busy database with a sentence rather than SQLite saying "locked"', () => {
    // `locking_mode = EXCLUSIVE` forces a state production does not produce. Under the write-ahead
    // log every real instance runs, a reader is never blocked by a writer: the rebuild's long
    // transaction, VACUUM and wal_checkpoint(TRUNCATE) all leave a newly arriving reader alone,
    // and this pragma appears nowhere outside this test. What openReadOnly's busy branch is
    // actually there for is SQLITE_BUSY_RECOVERY, while another connection replays the log, and
    // that lasts milliseconds - too short to provoke on purpose and too cheap to leave unhandled.
    // So the branch is kept and exercised through the one condition that can be held open, and
    // the assertion is on the shape of the refusal rather than on how it was reached.
    //
    // The call costs about five seconds of wall clock, which is openReadOnly's own busy_timeout
    // running out: the refusal is what the wait ends in. Called once and the error kept, rather
    // than the three toThrow calls the tests above use, because three would cost fifteen.
    test.db.$client.pragma('locking_mode = EXCLUSIVE')
    test.db.run(sql`insert into __drizzle_migrations (hash, created_at) values ('holds-the-lock', 1)`)

    let thrown: unknown
    try {
      openReadOnly(test.dir)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ConfigError)
    expect((thrown as Error).message).toMatch(/busy and did not come free/i)
    expect((thrown as Error).message).toMatch(/recovering the write-ahead log/i)
  }, 20_000)

  it('refuses a database that exists but was never migrated', () => {
    // openDatabase creates the physical file before migrateToLatest runs, so a migration that
    // fails leaves exactly this: a file with no __drizzle_migrations table at all, not just one
    // with zero rows. Built directly with better-sqlite3, deliberately bypassing createTestDatabase
    // (which migrates) and openDatabase (which would create the file in the same bare state, but
    // the point is to prove openReadOnly copes with a file it did not create).
    bareDir = mkdtempSync(join(tmpdir(), 'haelan-bare-'))
    const client = new BetterSqlite3(join(bareDir, DATABASE_FILENAME))
    client.close()

    expect(() => openReadOnly(bareDir!)).toThrow(ConfigError)
    expect(() => openReadOnly(bareDir!)).toThrow(/older than this build/i)
  })
})
