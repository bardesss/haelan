import { afterEach, describe, expect, test } from 'vitest'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import { RebuildStateStore } from '../src/store/rebuildState.ts'
import { seedRebuildable } from '../src/testing/fixtures.ts'
import type { Rebuildable } from '../src/testing/fixtures.ts'

// Same fixture rebuild.test.ts uses: one person, one archived heart rate window, one archived
// sleep window, and one archived rollup. seedRebuildable's own corruptOneArchivedBody is what
// rebuild.test.ts's rollback tests use to make a replay throw, and that is reused here rather
// than invented again: it is the cheapest honest way to fail a replay this codebase already has.
let h: Rebuildable
afterEach(() => { h.cleanup() })

describe('runRebuild, recording each person\'s outcome', () => {
  test('records a success after the commit, with the time the rebuild ran', () => {
    h = seedRebuildable()
    const store = new RebuildStateStore(h.db)

    const report = runRebuild({ ...h.deps, nowMs: 5_000, rebuildState: store })

    // The rebuild itself still has to succeed, or the assertions below would be trivially true
    // of a person nothing happened to.
    expect(report.people).toHaveLength(1)
    expect(report.failures).toEqual([])
    expect(store.get(h.personId)?.lastSuccessAtMs).toBe(5_000)
    expect(store.get(h.personId)?.consecutiveFailures).toBe(0)
  })

  test('records a failure that its own transaction rolled back', () => {
    h = seedRebuildable()
    // Ruins the gzip body of one archived payload, which makes archive.getBody throw when
    // replayPerson calls it - inside the person's transaction, which then rolls back. This is
    // the test that proves the store write survives: recordFailure only shows up here if
    // runRebuild calls it from the catch block, after the rollback has already happened, rather
    // than from inside the transaction callback where it would roll back with everything else.
    h.corruptOneArchivedBody()
    const store = new RebuildStateStore(h.db)

    const report = runRebuild({ ...h.deps, nowMs: 7_000, rebuildState: store })

    expect(report.failures).toHaveLength(1)
    const row = store.get(h.personId)
    expect(row?.consecutiveFailures).toBe(1)
    expect(row?.lastError).not.toBeNull()
    expect(row?.lastAttemptAtMs).toBe(7_000)
    expect(row?.lastErrorAtMs).toBe(7_000)
    // The rebuild never committed for this person, so there is nothing to call a success.
    expect(row?.lastSuccessAtMs).toBeNull()
  })
})
