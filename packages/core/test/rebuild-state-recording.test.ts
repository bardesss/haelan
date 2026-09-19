import { afterEach, describe, expect, test } from 'vitest'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import { RebuildStateStore } from '../src/store/rebuildState.ts'
import { seedRebuildable } from '../src/testing/fixtures.ts'
import type { Rebuildable } from '../src/testing/fixtures.ts'

// Same fixture rebuild.test.ts uses: one person, one archived heart rate window, one archived
// sleep window, and one archived rollup. seedRebuildable's own corruptArchive is what
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
    // Leaves the person with more unreplayable pages in a row than the breaker tolerates, so
    // replayPerson abandons them rather than dropping page by page - inside the person's
    // transaction, which then rolls back. This is
    // the test that proves the store write survives: recordFailure only shows up here if
    // runRebuild calls it from the catch block, after the rollback has already happened, rather
    // than from inside the transaction callback where it would roll back with everything else.
    h.corruptArchive()
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

/**
 * A store whose writes fail the way a real one can: SQLITE_BUSY past the busy timeout.
 *
 * Not hypothetical. The boot rebuild runs while the HTTP server is already answering, and
 * recordSuccess opens a write transaction of its own - by design, so it cannot be rolled back
 * with the rebuild it describes. A write transaction is exactly what another writer can lock it
 * out of, and better-sqlite3 throws rather than queueing once the busy timeout is spent.
 */
class FailingRecorder extends RebuildStateStore {
  readonly #failing: 'success' | 'failure'

  constructor(db: Rebuildable['db'], failing: 'success' | 'failure') {
    super(db)
    this.#failing = failing
  }

  override recordSuccess(input: Parameters<RebuildStateStore['recordSuccess']>[0]): void {
    if (this.#failing === 'success') throw new Error('SQLITE_BUSY: database is locked')
    super.recordSuccess(input)
  }

  override recordFailure(input: Parameters<RebuildStateStore['recordFailure']>[0]): void {
    if (this.#failing === 'failure') throw new Error('SQLITE_BUSY: database is locked')
    super.recordFailure(input)
  }
}

/**
 * Recording observes the rebuild; it never takes part in it. Before these two, a throw out of
 * either recorder escaped the per-person loop and rejected the whole call, after that person's
 * own transaction had already committed - so contention this unit did not create would leave the
 * boot sequence never starting sync for ANYBODY. Contention there was caught per person before
 * this branch, which makes that a change to rebuild behaviour, the one thing #276a promised not
 * to make.
 */
describe('runRebuild, when recording the outcome is what fails', () => {
  test('still reports the person it rebuilt when recording the success throws', () => {
    h = seedRebuildable()
    h.seedSecondPerson()

    const report = runRebuild({
      ...h.deps, nowMs: 5_000, rebuildState: new FailingRecorder(h.db, 'success'),
    })

    // Both people, not only the first: the throw used to abandon the loop, so whoever came after
    // the person whose recording failed was never rebuilt at all.
    expect(report.people.map((person) => person.personId).sort()).toEqual(['p1', 'p2'])
    expect(report.failures).toEqual([])
  })

  test('still reports the person it could not rebuild when recording the failure throws', () => {
    h = seedRebuildable()
    h.corruptArchive()

    const report = runRebuild({
      ...h.deps, nowMs: 7_000, rebuildState: new FailingRecorder(h.db, 'failure'),
    })

    // The failure the rebuild actually had, not the recorder's. Losing the durable record is a
    // degradation; losing the report is how the boot sequence stops telling anybody anything.
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]?.personId).toBe(h.personId)
    expect(report.failures[0]?.error.message).not.toContain('SQLITE_BUSY')
  })
})
