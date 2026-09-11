import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { openReadOnly, latestMigrationWhen } from '../src/db/openReadOnly.ts'
import { closeDatabase } from '../src/db/open.ts'
import { ConfigError } from '../src/errors.ts'
import { people } from '../src/db/schema/index.ts'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1', { displayName: 'Robin' })
})
afterEach(() => test.cleanup())

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
})
