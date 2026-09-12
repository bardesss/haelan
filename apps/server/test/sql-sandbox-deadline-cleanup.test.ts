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
 * only on the worker's `'exit'` event. The sandbox suite's own deadline case sends a query bounded
 * at x < 2,000,000,000, which - at the throughput measured while choosing this file's own bound,
 * roughly 4-6 million rows/second - keeps that worker's native call running, and `busy` held,
 * for several minutes after the 5-second rejection already fired. A second deadline-shaped test
 * placed right after it in the same file would inherit that still-`true` `busy` flag and be
 * refused as "another sql_query is already running" before its own query ever started - confirmed
 * by trying exactly that. Vitest gives each test *file* a fresh module instance by default
 * (`isolate: true`), so a separate file is what actually gets this test a clean `busy = false` to
 * start from, not a workaround for a flaky assertion.
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
    // projection file open. This is the case that caught the EPERM bug in apps/server/src/mcp/
    // tools/sql.ts: cleanup cannot happen at the rejection, only later, once the worker's 'exit'
    // event proves the handle is actually gone. Calling runSql and makeProjectionDir directly,
    // rather than through the sql_query tool, is what gives this test the path to poll - the tool
    // itself never exposes it.
    //
    // The bound (60,000,000) is chosen empirically on this machine to reliably run past the
    // 5-second deadline while still finishing, once left to run to completion, well inside this
    // test's own budget: a plain, un-workered recursive count on this machine measured 4.1-5.8
    // million rows/second across two separate runs, and the margin below is sized off the slower
    // of the two on purpose.
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
