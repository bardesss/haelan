import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { makeDropCollector, withPage } from '../src/rebuild/withPage.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

let fixture: TestDatabase
beforeEach(() => {
  fixture = createTestDatabase()
  seedPerson(fixture.db, 'p1')
  fixture.db.run(sql`create table probe (id integer primary key)`)
})
afterEach(() => fixture.cleanup())

describe('withPage', () => {
  it('keeps the writes of a unit that succeeded', () => {
    const c = makeDropCollector()
    fixture.db.transaction((tx) => {
      const ok = withPage(tx, { dataType: 'sleep', pages: 1 }, c, () => {
        tx.run(sql`insert into probe (id) values (1)`)
      })
      expect(ok).toBe(true)
    })
    expect(fixture.db.get<{ n: number }>(sql`select count(*) as n from probe`)?.n).toBe(1)
  })

  it('rolls back only the failing unit, leaving its neighbours', () => {
    const c = makeDropCollector()
    fixture.db.transaction((tx) => {
      withPage(tx, { dataType: 'sleep', pages: 1 }, c, () => {
        tx.run(sql`insert into probe (id) values (1)`)
      })
      const ok = withPage(tx, { dataType: 'sleep', pages: 1 }, c, () => {
        tx.run(sql`insert into probe (id) values (2)`)
        tx.run(sql`insert into probe (id) values (2)`) // UNIQUE, throws
      })
      expect(ok).toBe(false)
      withPage(tx, { dataType: 'sleep', pages: 1 }, c, () => {
        tx.run(sql`insert into probe (id) values (3)`)
      })
    })
    const ids = fixture.db.all<{ id: number }>(sql`select id from probe order by id`)
    expect(ids.map((r) => r.id)).toEqual([1, 3])
  })

  // The property this pins is now about our own code, not drizzle's: withPage owns the savepoint
  // it opens, so a leak can only come from a path inside withPage itself forgetting to close one.
  //
  // The brief this test came from asserted the absence of a leak indirectly, by committing after
  // 500 drops and checking that the outer commit succeeds and the row count is right. That does
  // NOT discriminate: SQLite silently releases every savepoint still open when the transaction
  // that contains it commits (checked directly against better-sqlite3 - a loop of 500
  // `savepoint`/`rollback to savepoint` pairs with the closing `release savepoint` deleted still
  // commits cleanly and leaves the same row count as the version that releases properly). A test
  // built on commit-success-and-row-count would stay green even if withPage's failure branch
  // stopped releasing entirely, so it would not have caught the very bug it was written for.
  //
  // What actually pins "no leak" is the SQL withPage issues against the connection: every
  // `savepoint` statement must be matched by exactly one `release savepoint`, on the success path
  // and the drop path alike. That is asserted here directly, by intercepting every statement
  // better-sqlite3 prepares. Confirmed to fail: temporarily deleting the `release savepoint` call
  // on withPage's drop path turns `releases` into 0 while `opens` stays 500.
  it('does not leak a savepoint per drop: every savepoint it opens is released exactly once', () => {
    const client = fixture.db.$client
    const originalPrepare = client.prepare.bind(client)
    const statements: string[] = []
    client.prepare = ((source: string) => {
      statements.push(source)
      return originalPrepare(source)
    }) as typeof client.prepare

    const c = makeDropCollector()
    try {
      fixture.db.transaction((tx) => {
        for (let i = 0; i < 500; i += 1) {
          withPage(tx, { dataType: 'sleep', pages: 1 }, c, () => {
            tx.run(sql`insert into probe (id) values (1)`)
            tx.run(sql`insert into probe (id) values (1)`) // UNIQUE, throws every time
          })
        }
        tx.run(sql`insert into probe (id) values (99)`)
      })
    } finally {
      client.prepare = originalPrepare
    }

    const opens = statements.filter((s) => /^savepoint /i.test(s)).length
    const rollbacks = statements.filter((s) => /^rollback to savepoint /i.test(s)).length
    const releases = statements.filter((s) => /^release savepoint /i.test(s)).length
    expect(opens).toBe(500)
    expect(rollbacks).toBe(500)
    expect(releases).toBe(opens)

    // The outcome that actually matters to a rebuild, kept alongside the SQL-level check above
    // rather than in place of it: 500 failing units must cost nothing beyond themselves.
    expect(fixture.db.get<{ n: number }>(sql`select count(*) as n from probe`)?.n).toBe(1)
    expect(c.droppedPages).toBe(500)
  })

  it('groups 500 identical failures into one reason', () => {
    const c = makeDropCollector()
    fixture.db.transaction((tx) => {
      for (let i = 0; i < 500; i += 1) {
        withPage(tx, { dataType: 'sleep', pages: 1 }, c, () => {
          tx.run(sql`insert into probe (id) values (1)`)
          tx.run(sql`insert into probe (id) values (1)`)
        })
      }
    })
    expect([...c.drops.values()]).toHaveLength(1)
    expect([...c.drops.values()][0]?.pages).toBe(500)
  })

  it('rethrows a fatal error instead of dropping the unit', () => {
    const c = makeDropCollector()
    expect(() => fixture.db.transaction((tx) => {
      withPage(tx, { dataType: 'sleep', pages: 1 }, c, () => {
        throw Object.assign(new Error('disk is full'), { code: 'SQLITE_FULL' })
      })
    })).toThrow('disk is full')
    expect(c.droppedPages).toBe(0)
  })

  it('counts consecutive drops and resets on a success', () => {
    const c = makeDropCollector()
    fixture.db.transaction((tx) => {
      withPage(tx, { dataType: 'sleep', pages: 1 }, c, () => { throw new Error('bad') })
      expect(c.consecutive).toBe(1)
      withPage(tx, { dataType: 'sleep', pages: 1 }, c, () => {
        tx.run(sql`insert into probe (id) values (7)`)
      })
      expect(c.consecutive).toBe(0)
    })
  })
})
