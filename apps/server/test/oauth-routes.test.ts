import { describe, it, expect, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const headers = { origin: 'http://localhost:4235', host: 'localhost:4235' }

// Walks the wizard as far as the consent step and returns the session cookie.
async function readyForConsent(h: Harness): Promise<string> {
  const created = await h.app.inject({
    method: 'POST', url: '/api/setup/account', headers,
    payload: { username: 'bartus', password: 'a good long password', displayName: 'Bartus', timezone: 'Europe/Amsterdam' },
  })
  const cookie = created.cookies.find((c) => c.name === 'haelan_session')!.value
  await h.app.inject({
    method: 'POST', url: '/api/setup/instance-url', headers, cookies: { haelan_session: cookie },
    payload: { baseUrl: 'http://localhost:4235', consentPath: 'localhost' },
  })
  await h.app.inject({
    method: 'POST', url: '/api/setup/google-client', headers, cookies: { haelan_session: cookie },
    payload: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret' },
  })
  return cookie
}

describe('the consent handoff', () => {
  it('redirects to Google with the exact redirect URI the wizard showed', async () => {
    harness = await withServer()
    const cookie = await readyForConsent(harness)
    const response = await harness.app.inject({
      method: 'GET', url: '/oauth/start', headers, cookies: { haelan_session: cookie },
    })
    expect(response.statusCode).toBe(302)
    const location = new URL(response.headers.location as string)
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:4235/oauth/callback')
    expect(location.searchParams.get('access_type')).toBe('offline')
    expect(location.searchParams.get('state')).toBeTruthy()
  })

  it('refuses to start consent without a session', async () => {
    harness = await withServer()
    await readyForConsent(harness)
    expect((await harness.app.inject({ method: 'GET', url: '/oauth/start' })).statusCode).toBe(401)
  })

  it('refuses to start consent before the client is stored', async () => {
    harness = await withServer()
    const created = await harness.app.inject({
      method: 'POST', url: '/api/setup/account', headers,
      payload: { username: 'bartus', password: 'a good long password', displayName: 'Bartus', timezone: 'Europe/Amsterdam' },
    })
    const cookie = created.cookies.find((c) => c.name === 'haelan_session')!.value
    const response = await harness.app.inject({
      method: 'GET', url: '/oauth/start', headers, cookies: { haelan_session: cookie },
    })
    expect(response.statusCode).toBe(409)
  })

  it('stores the refresh token encrypted and marks setup complete', async () => {
    harness = await withServer({ google: 'ok' })
    const cookie = await readyForConsent(harness)
    const start = await harness.app.inject({
      method: 'GET', url: '/oauth/start', headers, cookies: { haelan_session: cookie },
    })
    const state = new URL(start.headers.location as string).searchParams.get('state')!
    const callback = await harness.app.inject({
      method: 'GET', url: `/oauth/callback?code=good&state=${encodeURIComponent(state)}`, headers,
    })
    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toBe('/setup/backfill')

    const stored = harness.app.haelan.instance.db.$client
      .prepare('select refresh_token_encrypted from credentials').get() as { refresh_token_encrypted: string }
    expect(stored.refresh_token_encrypted).not.toContain('stub-refresh-token')
    expect(harness.app.haelan.stores.settings.get()?.setupCompletedAtMs).not.toBeNull()
  })

  it('starts the first sync itself, rather than leaving the backfill screen empty for an hour', async () => {
    harness = await withServer({ google: 'ok' })
    const cookie = await readyForConsent(harness)
    const start = await harness.app.inject({
      method: 'GET', url: '/oauth/start', headers, cookies: { haelan_session: cookie },
    })
    const state = new URL(start.headers.location as string).searchParams.get('state')!
    await harness.app.inject({
      method: 'GET', url: `/oauth/callback?code=good&state=${encodeURIComponent(state)}`, headers,
    })
    // The scheduler's first tick is a whole interval away, so without a kick here the screen
    // the callback redirects to would say nothing had started, and be right.
    const runner = harness.app.haelan.runner
    expect(runner.status().running || runner.status().lastFinishedAtMs !== null).toBe(true)
    while (runner.status().running) await new Promise((resolve) => setImmediate(resolve))
  })

  it('sends a rejected state back to the connect step rather than exchanging it', async () => {
    harness = await withServer({ google: 'ok' })
    await readyForConsent(harness)
    const response = await harness.app.inject({ method: 'GET', url: '/oauth/callback?code=good&state=forged' })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/setup/google?error=bad_state')
    expect(harness.app.haelan.stores.settings.get()?.setupCompletedAtMs ?? null).toBeNull()
  })

  it('reports a redirect URI mismatch as itself, with the message the console needs', async () => {
    harness = await withServer({ google: 'redirect_uri_mismatch' })
    const cookie = await readyForConsent(harness)
    const start = await harness.app.inject({
      method: 'GET', url: '/oauth/start', headers, cookies: { haelan_session: cookie },
    })
    const state = new URL(start.headers.location as string).searchParams.get('state')!
    const response = await harness.app.inject({
      method: 'GET', url: `/oauth/callback?code=good&state=${encodeURIComponent(state)}`,
    })
    expect(response.headers.location).toBe('/setup/google?error=exchange_failed')
    const detail = await harness.app.inject({ method: 'GET', url: '/api/setup/last-error' })
    expect(String(detail.json().message)).toContain('redirect_uri_mismatch')
  })

  it('reports a disabled API from the profile probe, not from the exchange', async () => {
    harness = await withServer({ google: 'service_disabled' })
    const cookie = await readyForConsent(harness)
    const start = await harness.app.inject({
      method: 'GET', url: '/oauth/start', headers, cookies: { haelan_session: cookie },
    })
    const state = new URL(start.headers.location as string).searchParams.get('state')!
    await harness.app.inject({ method: 'GET', url: `/oauth/callback?code=good&state=${encodeURIComponent(state)}` })
    const detail = await harness.app.inject({ method: 'GET', url: '/api/setup/last-error' })
    expect(String(detail.json().message)).toContain('not enabled')
    // The probe failed, so nothing was stored: an instance that says it is set up and cannot
    // read a single data point is the failure mode this whole step exists to prevent.
    expect(harness.app.haelan.stores.settings.get()?.setupCompletedAtMs ?? null).toBeNull()
    // The person id is a uuid the route minted, so ask which people are connected at all
    // rather than guessing one and asserting nothing.
    expect(harness.app.haelan.stores.credentials.listConnectedPeople()).toEqual([])
  })

  it('passes a user refusal straight through', async () => {
    harness = await withServer({ google: 'ok' })
    await readyForConsent(harness)
    const response = await harness.app.inject({ method: 'GET', url: '/oauth/callback?error=access_denied&state=x' })
    expect(response.headers.location).toBe('/setup/google?error=access_denied')
  })
})
