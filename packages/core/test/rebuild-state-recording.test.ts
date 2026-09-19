import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import { RebuildStateStore, producedNothing } from '../src/store/rebuildState.ts'
import { rawPayloads } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
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
    // Corrupts every archived body, so nothing at all commits and replayPerson abandons the person
    // through the zero-committed rule rather than recording page by page - inside the person's
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

  test('records what a partial rebuild dropped, and still stamps the person', () => {
    h = seedRebuildable()
    // Ruins only the archived sleep body, leaving the heart-rate window and the rollup readable:
    // one unreplayable page among several good ones, which is the whole point of #276b - the
    // person still commits and gets stamped, carrying one drop rather than losing the rebuild.
    h.db.update(rawPayloads).set({ bodyGzip: Buffer.from('not gzip at all', 'utf8') })
      .where(and(eq(rawPayloads.personId, h.personId), eq(rawPayloads.dataType, 'sleep')))
      .run()
    const store = new RebuildStateStore(h.db)

    const report = runRebuild({ ...h.deps, rebuildState: store, nowMs: 5_000 })

    expect(report.failures).toHaveLength(0)
    expect(report.people[0]?.droppedPages).toBe(1)
    const row = store.get(h.personId)
    expect(row?.droppedPages).toBe(1)
    expect(row?.drops).toHaveLength(1)
    expect(row?.consecutiveFailures).toBe(0)
    // The stamp is what resumes their sync, and it is the whole point of the change: a person who
    // dropped pages must not be left on their old derivation version waiting for a human to
    // notice. Reading it straight off the people store, not off the report, is deliberate - this
    // is the same column peopleNeedingRebuild reads to decide whether sync may resume for them.
    expect(h.deps.peopleStore.list().find((p) => p.id === h.personId)?.builtDerivationVersion)
      .toBe(DERIVATION_VERSION)
  })

  /**
   * The silent outcome of issue 289, reproduced rather than described.
   *
   * Every archived body is replaced with one that carries a real, non-empty list of data points
   * whose inner shape no current mapper recognises - the payload key and the value key have both
   * moved. That is what catalogue drift produces in the field, and it is the distinction the
   * whole design turns on: the envelope is intact and full, so the archive plainly HELD data,
   * while every mapper walks the points, finds nothing it knows, and returns empty. Nothing
   * throws, so no page is dropped, no breaker fires, and the person is stamped current.
   *
   * An earlier version of this test used `{}`, which proved only that the columns were wired up:
   * `{}` is structurally an empty answer, indistinguishable from the healthy quiet member the
   * test below rebuilds, and a predicate that flagged both would have passed it.
   */
  test('reports a rebuild whose archive held data that no mapper could read', () => {
    h = seedRebuildable()
    h.db.update(rawPayloads).set({ bodyGzip: gzipSync(Buffer.from(DRIFTED_BODY, 'utf8')) })
      .where(eq(rawPayloads.personId, h.personId)).run()
    const store = new RebuildStateStore(h.db)

    const report = runRebuild({ ...h.deps, nowMs: 5_000, rebuildState: store })

    // Not a failure and not a drop: the point of the test is that every existing signal is clean.
    expect(report.failures).toEqual([])
    expect(report.people[0]?.droppedPages).toBe(0)
    expect(report.people[0]?.rowsWritten).toBe(0)
    // Asserted as a positive number rather than pinned to the fixture's own page count, which is
    // the fixture's business and changes whenever a data source is added to it.
    expect(report.people[0]?.payloadsWithData).toBeGreaterThan(0)
    const row = store.get(h.personId)
    expect(row?.rowsWritten).toBe(0)
    expect(row?.payloadsWithData).toBe(report.people[0]?.payloadsWithData)
    expect(producedNothing(row)).toBe(true)
  })

  /**
   * The member this feature must never speak about, and the case the first design got wrong.
   *
   * Every archived body is a well-formed, entirely ordinary EMPTY answer: a 200 whose dataPoints
   * list has nothing in it. api/client.ts archives a response before parsing it and
   * unconditionally, so these are archived exactly like full ones - which means a connected
   * member whose devices reported nothing across the horizon holds a page per window per data
   * type and derives not one row. Counting pages, as the column first did, flagged them and told
   * them a later version might read what was never there.
   *
   * So the assertion that matters here is the negative one. It fails against a `payloads_seen`
   * that counts pages, and passes only against one that counts payloads carrying data.
   */
  test('stays quiet about a member whose archive is full of empty answers', () => {
    h = seedRebuildable()
    h.db.update(rawPayloads).set({ bodyGzip: gzipSync(Buffer.from(EMPTY_ANSWER_BODY, 'utf8')) })
      .where(eq(rawPayloads.personId, h.personId)).run()
    const store = new RebuildStateStore(h.db)

    const report = runRebuild({ ...h.deps, nowMs: 5_000, rebuildState: store })

    expect(report.failures).toEqual([])
    expect(report.people[0]?.rowsWritten).toBe(0)
    // Asserted so the zero below cannot pass vacuously: the archive really does hold pages, and
    // the old page-counting column returned exactly this number. Without it, an empty archive
    // would satisfy the whole test.
    const pages = h.db.select({ n: sql<number>`count(*)` }).from(rawPayloads)
      .where(eq(rawPayloads.personId, h.personId)).get()?.n ?? 0
    expect(pages).toBeGreaterThan(0)
    // Only the answers are empty, not the archive. This asserts the column is not a page count.
    expect(report.people[0]?.payloadsWithData).toBe(0)
    const row = store.get(h.personId)
    expect(row?.payloadsWithData).toBe(0)
    expect(producedNothing(row)).toBe(false)
  })

  // The other half of the pair, and the reason there are two columns. A rebuild that did read
  // rows must leave producedNothing false, or the surfaces would report every healthy person.
  test('leaves a rebuild that wrote rows reporting nothing', () => {
    h = seedRebuildable()
    const store = new RebuildStateStore(h.db)

    const report = runRebuild({ ...h.deps, nowMs: 5_000, rebuildState: store })

    expect(report.people[0]?.rowsWritten).toBeGreaterThan(0)
    expect(producedNothing(store.get(h.personId))).toBe(false)
  })

  /**
   * Segments count as rows written. A person whose archive replays to sleep stages and nothing
   * else has data, and a sum that left segments out would report them as having produced
   * nothing. Asserted through the arithmetic rather than by seeding a segments-only archive:
   * the report's own figures are what the sum is made of, so this catches a term going missing
   * from it whatever the fixture holds.
   */
  test('counts every rebuilt table in rowsWritten, segments included', () => {
    h = seedRebuildable()

    const report = runRebuild({ ...h.deps, nowMs: 5_000 })
    const person = report.people[0]!

    const rows = h.snapshot()
    expect(rows.sessionSegments.length).toBeGreaterThan(0)
    expect(person.rowsWritten).toBe(
      person.samples + person.sessions + rows.sessionSegments.length
      + person.observations + person.dailyRows,
    )
  })
})

/**
 * One archived body whose envelope is intact and full, and whose points nothing can read.
 *
 * `heartRateV2` and `beatsPerMinuteV2` are both invented: the catalogue's heart-rate type looks
 * for `heartRate.beatsPerMinute`, finds neither, and skips the point. The shape is otherwise a
 * real one, down to the dataSource and the sample time, which is what a renamed field looks like
 * coming back from a live API.
 *
 * Used for every data type in the fixture, not only heart rate. The sessions and observations
 * mappers walk the same `dataPoints` list and find nothing they know either, and for the rollup
 * page readEnvelope reports the body unreadable - there is no `rollupDataPoints` key, and a
 * non-empty list of objects is sitting under a name it does not expect, which is the envelope
 * reader's own definition of a field that has moved.
 */
const DRIFTED_BODY = JSON.stringify({
  dataPoints: [{
    dataSource: { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' },
    heartRateV2: {
      sampleTime: { physicalTime: '2026-08-18T10:00:00Z', utcOffset: '7200s' },
      beatsPerMinuteV2: '62',
    },
  }],
})

/**
 * The ordinary empty answer, which proto3 JSON emits as an omitted repeated field or as an empty
 * list. Spelled with the key present and empty rather than omitted because that is the harder
 * case for the envelope reader to get right, and because it is unambiguous to read here.
 */
const EMPTY_ANSWER_BODY = JSON.stringify({ dataPoints: [] })

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
