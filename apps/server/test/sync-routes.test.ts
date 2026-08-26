import { describe, it, expect, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const headers = { origin: 'http://localhost:4235', host: 'localhost:4235' }

async function sessionCookie(h: Harness): Promise<string> {
  const response = await h.app.inject({
    method: 'POST', url: '/api/auth/login', headers,
    payload: { username: 'bartus', password: 'a good long password' },
  })
  return response.cookies.find((c) => c.name === 'haelan_session')!.value
}

// tryStart leaves a run going. Letting it finish keeps the database open until it is done,
// rather than closing it underneath a backfill in cleanup.
async function settle(h: Harness): Promise<void> {
  while (h.app.haelan.runner.runState().running) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('sync routes', () => {
  it('refuses status without a session, because it names the data types a person syncs', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    expect((await harness.app.inject({ method: 'GET', url: '/api/sync/status' })).statusCode).toBe(401)
  })

  it('answers status from sync_state rather than from whatever the stream last said', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const cookie = await sessionCookie(harness)
    const response = await harness.app.inject({
      method: 'GET', url: '/api/sync/status', cookies: { haelan_session: cookie },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { running: boolean, backfill: unknown[] }
    expect(body.running).toBe(false)
    // A page that reloads mid backfill must see the truth without having been connected to
    // the stream when the events went out.
    expect(body.backfill.length).toBeGreaterThan(0)
  })

  it('starts a run on request and reports that it started', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const cookie = await sessionCookie(harness)
    const response = await harness.app.inject({
      method: 'POST', url: '/api/sync/run', headers, cookies: { haelan_session: cookie },
    })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ started: true })
    await settle(harness)
  })

  it('answers 409 when a run is already going rather than starting a second', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const cookie = await sessionCookie(harness)
    const inFlight = harness.app.haelan.runner.trigger('manual')
    const response = await harness.app.inject({
      method: 'POST', url: '/api/sync/run', headers, cookies: { haelan_session: cookie },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'already_running' })
    await inFlight
  })

  it('answers before the run it started has finished', async () => {
    // The run is parked on its first limiter call and cannot finish until this test lets it,
    // so the assertion below is about the route rather than about which of the two won a race.
    let release = () => {}
    const parked = new Promise<void>((resolve) => { release = resolve })
    let firstTake = true
    harness = await withServer({
      google: 'ok',
      limiter: { take: async () => { if (firstTake) { firstTake = false; await parked } } },
    })
    await harness.connectPerson()
    const cookie = await sessionCookie(harness)

    const response = await harness.app.inject({
      method: 'POST', url: '/api/sync/run', headers, cookies: { haelan_session: cookie },
    })
    expect(response.statusCode).toBe(202)
    // The point of 202 over 200: a backfill batch runs for minutes and the browser follows it
    // through the stream. A route that awaited the run would still be holding the socket here,
    // and this line would never be reached.
    expect(harness.app.haelan.runner.runState().running).toBe(true)

    release()
    await settle(harness)
  })

  it('refuses the stream without a session', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    expect((await harness.app.inject({ method: 'GET', url: '/api/sync/events' })).statusCode).toBe(401)
  })
})
