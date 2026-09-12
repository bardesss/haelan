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
 * only on the child's `'exit'` event. Under the worker_threads version of this sandbox, that
 * mattered a great deal here: `worker.terminate()` could not interrupt the native call
 * underneath it, so the sandbox suite's own deadline case left its worker - and `busy` - running
 * for several more seconds after its own assertion had already passed, and a second
 * deadline-shaped test placed right after it in the same file would inherit that still-`true`
 * flag and be refused as "another sql_query is already running" before its own query ever
 * started (confirmed by trying exactly that). Under child_process that residual window has
 * collapsed to single-digit milliseconds - `child.kill()` measured directly against this same
 * query shape - so the flakiness this file existed to dodge is largely gone. The separate file
 * stays anyway, now as cheap defense-in-depth rather than a load-bearing workaround: vitest gives
 * each test *file* a fresh module instance by default (`isolate: true`), so this still costs
 * nothing to keep and removes any last shred of doubt about `busy` crossing test boundaries.
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
  it('removes the projection file once the killed child actually exits', async () => {
    // The rejection fires the instant the deadline timer does; the query itself is still running
    // underneath it at that moment, blocked in a native call, and still holds the projection file
    // open. This is NOT the case that caught the EPERM bug - that was `sql-sandbox.test.ts`'s
    // deadline case, which goes through the actual `sql_query` tool and so exercises `sql.ts`'s
    // own wiring. This one calls `runSql` and `makeProjectionDir` directly, bypassing `sql.ts`
    // entirely, which is what gives it the projection path to poll (the tool never exposes it)
    // but also means it pins `runSql`'s own contract in isolation - not the tool's - and a future
    // reader should not delete this believing the other test already covers it: neither one, on
    // its own, proves what the other does.
    //
    // The bound (60,000,000) only needs to outlast the 5-second deadline - see the identical
    // reasoning on `sql-sandbox.test.ts`'s own deadline case, including why the bound no longer
    // has to be kept small for the sandbox's own sake now that the child is actually killed
    // rather than left to finish naturally.
    //
    // Under the worker_threads version this file used to run, the gap this test polls for was
    // measured at 8-10.5 seconds - `worker.terminate()` only lands when the native call itself
    // returns, around the query's own 13-15 second natural runtime. Measured directly against the
    // child_process version (a standalone harness driving this exact code path, reported by hand
    // in the M4 fix-wave report): the projection directory became removable ~9ms after the
    // rejection fired, not seconds. The poll loop below is sized to comfortably outlast that on a
    // slow CI machine without reintroducing the old multi-second wait as this test's normal
    // runtime.
    const projection = makeProjectionDir()
    alice.writeProjection(projection.path)
    const started = Date.now()
    await expect(runSql({
      projectionPath: projection.path,
      sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 60000000) SELECT count(*) FROM c',
      cleanup: projection.remove,
    })).rejects.toThrow(/did not finish within/)

    const dir = dirname(projection.path)
    const pollDeadline = started + 15_000
    while (existsSync(dir)) {
      if (Date.now() > pollDeadline) {
        throw new Error(`projection directory still present 15s after the query started: ${dir}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // The loop above is the real assertion: it can only exit by the directory disappearing or by
    // throwing. This restates that in `expect` form for the test report, not as a timing claim -
    // how long it actually took is a property of this machine's SQLite throughput on the day it
    // ran, and is reported by hand rather than pinned here.
    expect(existsSync(dir)).toBe(false)
  }, 20_000)
})

// Cleanup was, until now, only ever asserted on the hardest path above - the killed child.
// Nothing proved the directory also disappears on the two paths that leave a child without ever
// killing one: a query that finishes normally, and a call refused before a child even starts.
// Deleting `input.cleanup()` from runSql's busy branch would leave every other test in this suite
// green while each refused-as-busy call leaked its projection directory for the life of the
// container - these two close that gap. Both call `runSql`/`makeProjectionDir` directly, the same
// way the case above does, because the tool wrapper never exposes the projection path to poll.
describe('cleanup on the paths that never kill a child', () => {
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
    // call below to land while it is still true, without leaving a child running past this test.
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
