import { describe, it, expect, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// No google stub and no connectPerson: this is about rebuild_state, which the runner never
// touches through a sync at all, so the only setup any of these tests needs is a person to
// attach the row to. completeSetup is the harness's own way of producing that person.
describe('the runner reports a person\'s rebuild status', () => {
  it('reports a person who has never failed as not quarantined', async () => {
    harness = await withServer()
    await harness.completeSetup()

    expect(harness.app.haelan.runner.status('p1').rebuild).toEqual({
      quarantined: false, awaitingRebuild: false, droppedPages: 0, producedNothing: false,
      lastErrorAtMs: null, lastError: null, lastSuccessAtMs: null, drops: [],
    })
  })

  /**
   * The timestamp RebuildNotice needs to date droppedPages and producedNothing, which otherwise
   * sit unchanged from one boot to the next once a person's stamp goes current again - see
   * RebuildStatus.lastSuccessAtMs's own doc comment for why. Asserted here rather than only on
   * the admin route (which already returned this column): the per-person route is what
   * ControlRow reads, and until this test existed nothing caught it being absent from RunnerStatus.
   */
  it('reports when the last rebuild attempt committed, for dating a persistent state', async () => {
    harness = await withServer()
    await harness.completeSetup()
    harness.app.haelan.stores.rebuildState.recordSuccess({
      personId: 'p1', nowMs: 555, droppedPages: 2, rowsWritten: 10, payloadsWithData: 4, drops: [],
    })

    expect(harness.app.haelan.runner.status('p1').rebuild.lastSuccessAtMs).toBe(555)
  })

  it('reports a person whose last rebuild failed as quarantined', async () => {
    harness = await withServer()
    await harness.completeSetup()
    harness.app.haelan.stores.rebuildState.recordFailure({
      personId: 'p1', nowMs: 100, error: 'UNIQUE constraint failed',
    })

    const status = harness.app.haelan.runner.status('p1').rebuild
    expect(status.quarantined).toBe(true)
    expect(status.lastError).toBe('UNIQUE constraint failed')
  })

  it('clears the quarantine once a later rebuild commits', async () => {
    harness = await withServer()
    await harness.completeSetup()
    const store = harness.app.haelan.stores.rebuildState
    store.recordFailure({ personId: 'p1', nowMs: 100, error: 'boom' })
    store.recordSuccess({
      personId: 'p1', nowMs: 200, droppedPages: 0, rowsWritten: 90, payloadsWithData: 4, drops: [],
    })

    expect(harness.app.haelan.runner.status('p1').rebuild.quarantined).toBe(false)
  })

  /**
   * The member's own half of issue 289. Their rebuild committed, dropped nothing and failed at
   * nothing, so every flag beside this one reads clean - and the archive it read produced not a
   * single row. Before this the control row had no way to know and showed them nothing at all.
   */
  it('reports a rebuild that read an archive and wrote no rows', async () => {
    harness = await withServer()
    await harness.completeSetup()
    harness.app.haelan.stores.rebuildState.recordSuccess({
      personId: 'p1', nowMs: 200, droppedPages: 0, rowsWritten: 0, payloadsWithData: 40, drops: [],
    })

    const status = harness.app.haelan.runner.status('p1').rebuild
    expect(status.producedNothing).toBe(true)
    // None of the existing signals say anything, which is the whole reason the pair was added.
    expect(status.quarantined).toBe(false)
    expect(status.droppedPages).toBe(0)
    expect(status.lastError).toBeNull()
  })

  // The false alarm the payload count removes, asserted at the surface rather than only at the
  // predicate: a member connected an hour ago has nothing archived and nothing derived, and must
  // not be told their history came back empty.
  it('stays quiet about a person who had no archive to replay', async () => {
    harness = await withServer()
    await harness.completeSetup()
    harness.app.haelan.stores.rebuildState.recordSuccess({
      personId: 'p1', nowMs: 200, droppedPages: 0, rowsWritten: 0, payloadsWithData: 0, drops: [],
    })

    expect(harness.app.haelan.runner.status('p1').rebuild.producedNothing).toBe(false)
  })

  /**
   * The silent stop this whole unit exists to end, and the one no rebuild attempt precedes.
   *
   * PeopleStore.setTimezone nulls builtDerivationVersion in the same statement as the zone,
   * deliberately, and it is reachable from the Profile form. From the next tick both the sync
   * runner and the derive drainer skip that person, because peopleNeedingRebuild returns them -
   * and the rebuild only runs at boot, so nothing un-skips them until the container restarts.
   * rebuild_state meanwhile holds whatever their last actual rebuild wrote, which is a clean
   * success or nothing at all, so quarantined alone reports them as fine while their data has
   * in fact stopped.
   */
  it('reports a person whose stamp went stale with no rebuild attempt as awaiting one', async () => {
    harness = await withServer()
    await harness.completeSetup()
    harness.app.haelan.stores.rebuildState.recordSuccess({
      personId: 'p1', nowMs: 100, droppedPages: 0, rowsWritten: 90, payloadsWithData: 4, drops: [],
    })

    harness.app.haelan.stores.people.setTimezone('p1', 'Pacific/Auckland')

    const status = harness.app.haelan.runner.status('p1').rebuild
    expect(status.awaitingRebuild).toBe(true)
    // Nothing failed. Saying so would send an operator looking for an error that never happened.
    expect(status.quarantined).toBe(false)
    expect(status.lastError).toBeNull()
  })

  // A quarantined person is behind on their stamp too - the rollback took it with them - so the
  // raw fact is true of both. The route reports it rather than deciding between them; the
  // component that renders the two is where the precedence lives, because only there does saying
  // both at once do any harm.
  it('reports a quarantined person as awaiting a rebuild as well, since their stamp rolled back', async () => {
    harness = await withServer()
    await harness.completeSetup()
    harness.app.haelan.stores.people.setTimezone('p1', 'Pacific/Auckland')
    harness.app.haelan.stores.rebuildState.recordFailure({
      personId: 'p1', nowMs: 100, error: 'boom',
    })

    const status = harness.app.haelan.runner.status('p1').rebuild
    expect(status.quarantined).toBe(true)
    expect(status.awaitingRebuild).toBe(true)
  })
})

/**
 * The instance-wide half of the same question, and the reason it had to be asked at all.
 *
 * index.ts calls app.listen BEFORE the boot rebuild starts, and that rebuild runs in its own
 * process for as long as fifteen minutes on real data. Every person it has not reached yet has a
 * stale stamp for the whole of that window, so awaitingRebuild reads true for them during the
 * one run that is actually fixing them - and the copy that state used to render told the reader
 * a restart is what runs it. An operator who believed it would restart the container and kill the
 * rebuild. The flag below is what lets the browser tell "it is running now" apart from "nothing
 * is running and only a restart will start one".
 *
 * It sits on the envelope rather than inside `rebuild`, which is documented as carrying facts
 * about one household member's own data. Whether a boot rebuild is in flight is a fact about the
 * process, true of everybody at once, so it belongs beside running and lastFinishedAtMs.
 */
describe('the runner reports whether a boot rebuild is in flight', () => {
  it('reports no rebuild in flight on an instance whose boot rebuild has settled', async () => {
    harness = await withServer()
    await harness.completeSetup()

    expect(harness.app.haelan.runner.status('p1').rebuildInFlight).toBe(false)
  })

  // The same seam routes/maintenance.ts's two POST routes already gate on, read through the
  // ServerContext the runner is constructed with rather than plumbed in a second time.
  it('reports a rebuild in flight while the boot rebuild worker is still running', async () => {
    harness = await withServer({ rebuildInFlight: () => true })
    await harness.completeSetup()

    expect(harness.app.haelan.runner.status('p1').rebuildInFlight).toBe(true)
  })
})
