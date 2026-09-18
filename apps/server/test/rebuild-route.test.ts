import { describe, it, expect, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// The household-wide counterpart to sync-status-rebuild.test.ts: that file is one person asking
// about themselves through the runner, this one is an admin asking about everybody through
// rebuildState and PeopleStore directly. No google stub and no connectPerson needed for either -
// this is about rebuild_state, which a sync never touches, so completeSetup's own person is
// enough to hang a row off.
describe('GET /api/settings/rebuild', () => {
  it('refuses a member who is not an admin', async () => {
    harness = await withServer()
    await harness.addPerson({ id: 'p-outsider', displayName: 'Outsider', username: 'outsider' })
    const token = await harness.signIn('outsider', 'a good long password')

    const response = await harness.app.inject({
      method: 'GET', url: '/api/settings/rebuild',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.kind).toBe('forbidden')
  })

  it('lists every person with their rebuild state, and one never rebuilt as not quarantined', async () => {
    harness = await withServer()
    await harness.addPerson({ id: 'p2', displayName: 'Never Rebuilt', username: 'never' })
    const token = await harness.signIn()
    harness.app.haelan.stores.rebuildState.recordFailure({
      personId: 'p1', nowMs: 100, error: 'boom',
    })

    const response = await harness.app.inject({
      method: 'GET', url: '/api/settings/rebuild',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      people: {
        personId: string
        displayName: string
        quarantined: boolean
        droppedPages: number
        lastErrorAtMs: number | null
        lastError: string | null
        lastSuccessAtMs: number | null
        consecutiveFailures: number
        drops: unknown[]
      }[]
    }

    const failed = body.people.find((p) => p.personId === 'p1')
    expect(failed).toEqual({
      personId: 'p1',
      displayName: 'Robin',
      quarantined: true,
      droppedPages: 0,
      lastErrorAtMs: 100,
      lastError: 'boom',
      lastSuccessAtMs: null,
      consecutiveFailures: 1,
      drops: [],
    })

    // p2 has no row in rebuild_state at all - the row a person who has never been rebuilt has -
    // and still appears, reading as clean rather than being left off the list.
    const neverRebuilt = body.people.find((p) => p.personId === 'p2')
    expect(neverRebuilt).toEqual({
      personId: 'p2',
      displayName: 'Never Rebuilt',
      quarantined: false,
      droppedPages: 0,
      lastErrorAtMs: null,
      lastError: null,
      lastSuccessAtMs: null,
      consecutiveFailures: 0,
      drops: [],
    })
  })

  it('clears the quarantine once a later rebuild commits, same as the per-person route', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const store = harness.app.haelan.stores.rebuildState
    store.recordFailure({ personId: 'p1', nowMs: 100, error: 'boom' })
    store.recordSuccess({ personId: 'p1', nowMs: 200, droppedPages: 3, drops: [] })

    const response = await harness.app.inject({
      method: 'GET', url: '/api/settings/rebuild',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = response.json() as { people: { personId: string, quarantined: boolean, droppedPages: number, lastSuccessAtMs: number | null }[] }
    const person = body.people.find((p) => p.personId === 'p1')
    expect(person?.quarantined).toBe(false)
    expect(person?.droppedPages).toBe(3)
    expect(person?.lastSuccessAtMs).toBe(200)
  })
})
