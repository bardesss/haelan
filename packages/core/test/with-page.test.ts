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
  // many drops and checking that the outer commit succeeds and the row count is right. That does
  // NOT discriminate: SQLite silently releases every savepoint still open when the transaction
  // that contains it commits (checked directly against better-sqlite3 - a loop of drops whose
  // closing `release savepoint` is deleted still commits cleanly and leaves the same row count as
  // the version that releases properly). A test built on commit-success-and-row-count would stay
  // green even if withPage stopped releasing entirely on some path, so it would not have caught
  // the bug it was written for.
  //
  // A first version of this test only ever dropped units, so it never observed the success path's
  // own `release` - deleting that line left all assertions here green, because a healthy rebuild
  // (the common case, where nearly every unit commits) was never exercised at all. The loop below
  // alternates success and failure so both release sites are covered by the same run, in the ratio
  // a real rebuild is more likely to hit: succeeding is the norm, and a success-path leak stacks a
  // savepoint (and the sub-journal SQLite pins for it) for every single healthy unit, not just the
  // bad ones.
  //
  // What actually pins "no leak" is the SQL withPage issues against the connection: every
  // `savepoint` statement must be matched by exactly one `release savepoint`, on the success path
  // and the drop path alike. That is asserted here directly, by intercepting every statement
  // better-sqlite3 prepares. Confirmed to fail both ways: deleting the drop path's `release`
  // leaves `releases` short by the drop count; deleting the success path's `release` (inside the
  // `try`, guarding `fn()` only per the WHY comment on withPage) leaves it short by the success
  // count instead.
  it('does not leak a savepoint per drop or per success: every savepoint opened is released once', () => {
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
        for (let i = 0; i < 1000; i += 1) {
          if (i % 2 === 0) {
            // A fresh id every time: this is the success path, and it has to actually commit
            // rather than collide with a row a previous iteration already left behind.
            withPage(tx, { dataType: 'sleep', pages: 1 }, c, () => {
              tx.run(sql`insert into probe (id) values (${2000 + i})`)
            })
          } else {
            withPage(tx, { dataType: 'sleep', pages: 1 }, c, () => {
              tx.run(sql`insert into probe (id) values (1)`)
              tx.run(sql`insert into probe (id) values (1)`) // UNIQUE, throws every time
            })
          }
        }
      })
    } finally {
      client.prepare = originalPrepare
    }

    const opens = statements.filter((s) => /^savepoint /i.test(s)).length
    const rollbacks = statements.filter((s) => /^rollback to savepoint /i.test(s)).length
    const releases = statements.filter((s) => /^release savepoint /i.test(s)).length
    expect(opens).toBe(1000)
    expect(rollbacks).toBe(500)
    expect(releases).toBe(1000)

    // The outcome that actually matters to a rebuild, kept alongside the SQL-level check above
    // rather than in place of it: the 500 successes landed and the 500 drops cost nothing beyond
    // themselves.
    expect(fixture.db.get<{ n: number }>(sql`select count(*) as n from probe`)?.n).toBe(500)
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

  // Ruling B3: a fatal error has to rethrow BEFORE any recovery SQL, because `rollback to
  // savepoint` issued against a disk or connection a fatal code already says is broken can fail
  // in its own right and bury the real error under a confusing second one. Asserting only that
  // the throw happens (the test above) does not pin the ordering - it would pass just as well if
  // `rollback to savepoint` ran first and the rethrow followed it. This intercepts every statement
  // prepared against the connection and checks directly that no `rollback to savepoint` was ever
  // issued for the fatal case. Confirmed to fail: swapping withPage's fatal check to run after the
  // `rollback to` line turns this from 0 into 1.
  it('never issues a rollback to savepoint for a fatal error', () => {
    const client = fixture.db.$client
    const originalPrepare = client.prepare.bind(client)
    const statements: string[] = []
    client.prepare = ((source: string) => {
      statements.push(source)
      return originalPrepare(source)
    }) as typeof client.prepare

    const c = makeDropCollector()
    try {
      expect(() => fixture.db.transaction((tx) => {
        withPage(tx, { dataType: 'sleep', pages: 1 }, c, () => {
          throw Object.assign(new Error('disk is full'), { code: 'SQLITE_FULL' })
        })
      })).toThrow('disk is full')
    } finally {
      client.prepare = originalPrepare
    }

    const rollbacks = statements.filter((s) => /^rollback to savepoint /i.test(s)).length
    expect(rollbacks).toBe(0)
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
