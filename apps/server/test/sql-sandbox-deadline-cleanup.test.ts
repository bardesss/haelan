import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { PersonQuery, createTestDatabase, seedPerson } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { runSql, makeProjectionDir } from '../src/mcp/runSql.ts'

/**
 * In its own file, deliberately, not folded into `sql-sandbox.test.ts`'s `describe('the
 * deadline')` block.
 *
 * `busy` in `runSql.ts` is a module-level singleton, not per-instance state, and it is released
 * only on the worker's `'exit'` event. Even after being sized down to outlast the 5-second
 * deadline by only ~10 seconds rather than minutes (see the comment on the bound below, and the
 * matching one in `sql-sandbox.test.ts`), the sandbox suite's own deadline case still leaves its
 * worker's native call - and `busy` - running for a few seconds after its own assertion has
 * already passed. A second deadline-shaped test placed right after it in the same file would
 * inherit that still-`true` `busy` flag and be refused as "another sql_query is already running"
 * before its own query ever started - confirmed by trying exactly that. Vitest gives each test
 * *file* a fresh module instance by default (`isolate: true`), so a separate file is what actually
 * gets this test a clean `busy = false` to start from, not a workaround for a flaky assertion.
 */
let test: TestDatabase
let alice: PersonQuery

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'alice')
  alice = new PersonQuery(test.db, 'alice')
})
afterEach(() => test.cleanup())

describe('the deadline, and the file it leaves behind', () => {
  it('removes the projection file once the still-running worker actually exits', async () => {
    // The rejection fires the instant the deadline timer does; the query itself is still running
    // underneath it, blocked in a native call nothing here can interrupt, and it still holds the
    // projection file open. This is NOT the case that caught the EPERM bug - that was
    // `sql-sandbox.test.ts`'s deadline case, which goes through the actual `sql_query` tool and so
    // exercises `sql.ts`'s own wiring. This one calls `runSql` and `makeProjectionDir` directly,
    // bypassing `sql.ts` entirely, which is what gives it the projection path to poll (the tool
    // never exposes it) but also means it pins `runSql`'s own contract in isolation - not the
    // tool's - and a future reader should not delete this believing the other test already covers
    // it: neither one, on its own, proves what the other does.
    //
    // The bound (60,000,000) only needs to outlast the 5-second deadline, not run for minutes -
    // see the identical reasoning on `sql-sandbox.test.ts`'s own deadline case. Sized off two
    // direct throughput measurements on this machine (4.1-5.8 million rows/second for an
    // unworkered recursive count) to land this query's own natural runtime around 13-15 seconds,
    // which is also what the poll loop below measured directly, twice, end to end.
    const projection = makeProjectionDir()
    alice.writeProjection(projection.path)
    const started = Date.now()
    await expect(runSql({
      projectionPath: projection.path,
      sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 60000000) SELECT count(*) FROM c',
      cleanup: projection.remove,
    })).rejects.toThrow(/did not finish within/)

    const dir = dirname(projection.path)
    const pollDeadline = started + 90_000
    while (existsSync(dir)) {
      if (Date.now() > pollDeadline) {
        throw new Error(`projection directory still present 90s after the query started: ${dir}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    // The loop above is the real assertion: it can only exit by the directory disappearing or by
    // throwing. This restates that in `expect` form for the test report, not as a timing claim -
    // how long it actually took is a property of this machine's SQLite throughput on the day it
    // ran, and is reported by hand rather than pinned here.
    expect(existsSync(dir)).toBe(false)
  }, 95_000)
})

// Cleanup was, until now, only ever asserted on the hardest path above - the terminated worker.
// Nothing proved the directory also disappears on the two paths that leave a worker without ever
// terminating one: a query that finishes normally, and a call refused before a worker even
// starts. Deleting `input.cleanup()` from runSql's busy branch would leave every other test in
// this suite green while each refused-as-busy call leaked its projection directory for the life
// of the container - these two close that gap. Both call `runSql`/`makeProjectionDir` directly,
// the same way the case above does, because the tool wrapper never exposes the projection path to
// poll.
describe('cleanup on the paths that never terminate a worker', () => {
  it('removes the projection directory after a query that finishes normally', async () => {
    const projection = makeProjectionDir()
    alice.writeProjection(projection.path)
    await runSql({ projectionPath: projection.path, sql: 'SELECT 1', cleanup: projection.remove })
    expect(existsSync(dirname(projection.path))).toBe(false)
  })

  it('removes the projection directory for a call refused as busy', async () => {
    const first = makeProjectionDir()
    alice.writeProjection(first.path)
    // An unbounded recursive CTE, same as the row-cap case in sql-sandbox.test.ts: it returns
    // inside the cap in under a second, so this occupies `busy` just long enough for the second
    // call below to land while it is still true, without leaving a worker running past this test.
    const slow = runSql({
      projectionPath: first.path,
      sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c',
      cleanup: first.remove,
    })

    const second = makeProjectionDir()
    alice.writeProjection(second.path)
    await expect(runSql({ projectionPath: second.path, sql: 'SELECT 1', cleanup: second.remove }))
      .rejects.toThrow(/already running/)
    expect(existsSync(dirname(second.path))).toBe(false)

    await slow
  })
})
