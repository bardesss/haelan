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
      quarantined: false, droppedPages: 0, lastErrorAtMs: null, lastError: null, drops: [],
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
})
