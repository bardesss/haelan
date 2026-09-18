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
      quarantined: false, awaitingRebuild: false, droppedPages: 0, lastErrorAtMs: null,
      lastError: null, drops: [],
    })
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
    store.recordSuccess({ personId: 'p1', nowMs: 200, droppedPages: 0, drops: [] })

    expect(harness.app.haelan.runner.status('p1').rebuild.quarantined).toBe(false)
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
      personId: 'p1', nowMs: 100, droppedPages: 0, drops: [],
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
