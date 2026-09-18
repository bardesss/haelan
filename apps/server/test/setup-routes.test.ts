import { describe, it, expect, afterEach } from 'vitest'
import { SCOPES } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const headers = { origin: 'http://localhost:4235', host: 'localhost:4235' }

const createAccount = (h: Harness, overrides: Record<string, unknown> = {}) => h.app.inject({
  method: 'POST', url: '/api/setup/account', headers,
  payload: {
    username: 'robin', password: 'a good long password',
    displayName: 'Robin', timezone: 'Europe/Amsterdam', ...overrides,
  },
})

// The account step logs the owner in, so every step after it has a session to present.
async function accountCookie(h: Harness): Promise<string> {
  const created = await createAccount(h)
  return created.cookies.find((c) => c.name === 'haelan_session')!.value
}

describe('setup routes', () => {
  it('creates the person and the account together and logs the owner in', async () => {
    harness = await withServer()
    const response = await createAccount(harness)
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ personId: expect.any(String), step: 'instance-url' })
    expect(response.cookies.find((c) => c.name === 'haelan_session')).toBeDefined()
  })

  it('refuses a second account through the setup route', async () => {
    harness = await withServer()
    await createAccount(harness)
    expect((await createAccount(harness, { username: 'other' })).statusCode).toBe(409)
  })

  it('rejects a timezone the runtime does not know, and stores nothing', async () => {
    harness = await withServer()
    const response = await createAccount(harness, { timezone: 'Mars/Olympus' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
    expect(response.json().error.message).toContain('timezone')
    // Spec invariant 3 computes every day boundary in this zone, so a bad value here is wrong
    // data forever rather than a cosmetic error.
    expect(harness.app.haelan.stores.accounts.count()).toBe(0)
    expect(harness.app.haelan.stores.people.count()).toBe(0)
  })

  it('rejects a short password before hashing it', async () => {
    harness = await withServer()
    expect((await createAccount(harness, { password: 'short' })).statusCode).toBe(400)
  })

  it('leaves no orphan person row when account creation fails', async () => {
    harness = await withServer()
    // A blank username passes the route's type check and the password and timezone checks, so
    // the person row is already inserted when AccountStore rejects it. Without the rollback
    // the instance is left with a person nobody can log in as, and no way back through the
    // wizard, since the account step only reopens when there are no accounts.
    const response = await createAccount(harness, { username: '   ' })
    expect(response.statusCode).toBe(400)
    expect(harness.app.haelan.stores.people.count()).toBe(0)
    expect(harness.app.haelan.stores.accounts.count()).toBe(0)
  })

  it('stores the instance URL and hands back the exact redirect URI', async () => {
    harness = await withServer()
    const cookie = await accountCookie(harness)
    const response = await harness.app.inject({
      method: 'POST', url: '/api/setup/instance-url', headers, cookies: { haelan_session: cookie },
      payload: { baseUrl: 'http://localhost:4235', consentPath: 'localhost' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      step: 'google-client', redirectUri: 'http://localhost:4235/oauth/callback',
    })
  })

  it('refuses an instance URL that could never be registered', async () => {
    harness = await withServer()
    const cookie = await accountCookie(harness)
    const response = await harness.app.inject({
      method: 'POST', url: '/api/setup/instance-url', headers, cookies: { haelan_session: cookie },
      payload: { baseUrl: 'http://192.168.178.82:4235', consentPath: 'proxy' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
    expect(response.json().error.message).toContain('raw IP addresses')
  })

  it('lists concrete candidates and never a placeholder', async () => {
    harness = await withServer()
    const cookie = await accountCookie(harness)
    const response = await harness.app.inject({
      method: 'GET', url: '/api/setup/redirect-uris?host=box.tail1234.ts.net', headers,
      cookies: { haelan_session: cookie },
    })
    const body = response.json() as { candidates: Array<{ uri: string }> }
    expect(body.candidates.map((c) => c.uri)).toContain('https://box.tail1234.ts.net/oauth/callback')
    for (const candidate of body.candidates) expect(candidate.uri).not.toMatch(/[<>]/)
  })

  it('serves the scopes the consent screen has to declare, complete and copyable', async () => {
    harness = await withServer()
    const cookie = await accountCookie(harness)
    const response = await harness.app.inject({
      method: 'GET', url: '/api/setup/scopes', headers, cookies: { haelan_session: cookie },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { scopes: string[] }
    // The wizard counts what it is handed rather than printing a number, so this pins the length
    // only to catch the list silently shrinking between core and the route that serves it.
    expect(body.scopes).toHaveLength(11)
    for (const scope of body.scopes) {
      expect(scope.startsWith('https://www.googleapis.com/auth/googlehealth.')).toBe(true)
    }
  })

  it('asks Google for exactly the scopes it told the owner to declare', async () => {
    harness = await withServer()
    const cookie = await accountCookie(harness)
    const listed = (await harness.app.inject({
      method: 'GET', url: '/api/setup/scopes', headers, cookies: { haelan_session: cookie },
    })).json() as { scopes: string[] }
    // The failure this prevents: declaring five in the console because the wizard listed five,
    // then failing at consent because the request asked for six. One array, two readers.
    expect([...SCOPES].sort()).toEqual([...listed.scopes].sort())
  })

  // The account step is the only one that cannot take a session, because it is what creates the
  // one everything after it uses. Leaving the rest open let an unauthenticated caller on the
  // network set the instance's base URL, which is the address consent is later required to
  // match exactly.
  it('refuses an unauthenticated caller on every setup route after the account step', async () => {
    harness = await withServer()
    await createAccount(harness)
    const unauthenticated = [
      { method: 'POST' as const, url: '/api/setup/instance-url', payload: { baseUrl: 'http://localhost:4235', consentPath: 'localhost' } },
      { method: 'GET' as const, url: '/api/setup/redirect-uris?host=box.tail1234.ts.net' },
      { method: 'GET' as const, url: '/api/setup/scopes' },
      { method: 'GET' as const, url: '/api/setup/last-error' },
      { method: 'POST' as const, url: '/api/setup/companion', payload: {} },
    ]
    for (const request of unauthenticated) {
      const response = await harness.app.inject({ ...request, headers })
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(401)
    }
    // And nothing was written by the attempt that would have written something.
    expect(harness.app.haelan.stores.settings.get()).toBeNull()
  })

  it('refuses the setup routes once setup is finished', async () => {
    harness = await withServer()
    await harness.connectPerson()
    const response = await createAccount(harness)
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      error: { kind: 'setup_incomplete', code: 'setup_complete', message: expect.any(String) },
    })
  })

  it('finishes the wizard without a Google client through the companion route', async () => {
    harness = await withServer()
    const created = await createAccount(harness)
    const cookie = created.cookies.find((c) => c.name === 'haelan_session')!.value
    const personId = (created.json() as { personId: string }).personId
    const cookies = { haelan_session: cookie }

    const addressed = await harness.app.inject({
      method: 'POST', url: '/api/setup/instance-url', headers, cookies,
      payload: { baseUrl: 'http://localhost:4235', consentPath: 'localhost' },
    })
    expect(addressed.statusCode).toBe(200)

    const finished = await harness.app.inject({
      method: 'POST', url: '/api/setup/companion', headers, cookies, payload: {},
    })
    expect(finished.statusCode).toBe(200)
    expect(finished.json()).toEqual({ step: 'done' })
    expect(harness.app.haelan.stores.settings.get()?.companionMode).toBe(true)
    // Closing without Google is this person's phone choice, recorded next to the flag.
    expect(harness.app.haelan.stores.people.get(personId)?.companionPath).toBe(true)

    const state = await harness.app.inject({ method: 'GET', url: '/api/setup/state' })
    expect(state.json()).toEqual({ step: 'done', companionMode: true })

    // The gate is open now: the versioned surface answers instead of 409 setup_incomplete,
    // with no Google client and no consent anywhere behind it.
    const sources = await harness.app.inject({
      method: 'GET', url: `/api/v1/p/${personId}/sources`, headers, cookies,
    })
    expect(sources.statusCode).toBe(200)
  })

  it('refuses the companion route before the address step and after setup is done', async () => {
    harness = await withServer()
    const cookie = await accountCookie(harness)
    const cookies = { haelan_session: cookie }

    // At the instance-url step: there is no settings row yet to complete.
    const early = await harness.app.inject({
      method: 'POST', url: '/api/setup/companion', headers, cookies, payload: {},
    })
    expect(early.statusCode).toBe(409)
    expect(early.json()).toMatchObject({ error: { kind: 'setup_incomplete', code: 'wrong_step' } })
    expect(harness.app.haelan.stores.settings.get()).toBeNull()

    await harness.app.inject({
      method: 'POST', url: '/api/setup/instance-url', headers, cookies,
      payload: { baseUrl: 'http://localhost:4235', consentPath: 'localhost' },
    })
    const finished = await harness.app.inject({
      method: 'POST', url: '/api/setup/companion', headers, cookies, payload: {},
    })
    expect(finished.statusCode).toBe(200)

    // Finished means finished: the gate shuts the setup routes, this one included.
    const again = await harness.app.inject({
      method: 'POST', url: '/api/setup/companion', headers, cookies, payload: {},
    })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: { kind: 'setup_incomplete', code: 'setup_complete' } })
  })

  // The phone path was a one-way door: POST /api/setup/companion finishes the wizard with no
  // client, and at 'done' the gate shut POST /api/setup/google-client - the only writer of one
  // (oauth.ts) - while /oauth/start needs a readable client. So whoever chose the phone could
  // never add Google afterwards. The three cases below are the door, the refusal that has to
  // survive beside it, and the read the failed-consent screen depends on.
  async function companionInstance(h: Harness): Promise<{ cookies: { haelan_session: string }, personId: string }> {
    const created = await createAccount(h)
    const cookie = created.cookies.find((c) => c.name === 'haelan_session')!.value
    const personId = (created.json() as { personId: string }).personId
    const cookies = { haelan_session: cookie }
    await h.app.inject({
      method: 'POST', url: '/api/setup/instance-url', headers, cookies,
      payload: { baseUrl: 'http://localhost:4235', consentPath: 'localhost' },
    })
    const skipped = await h.app.inject({
      method: 'POST', url: '/api/setup/companion', headers, cookies, payload: {},
    })
    expect(skipped.json()).toEqual({ step: 'done' })
    return { cookies, personId }
  }

  it('lets a phone-only instance paste a client later, and keeps every other wizard route shut', async () => {
    harness = await withServer()
    const { cookies } = await companionInstance(harness)
    expect(harness.app.haelan.stores.credentials.getClient()).toBeNull()

    const pasted = await harness.app.inject({
      method: 'POST', url: '/api/setup/google-client', headers, cookies,
      payload: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret' },
    })
    expect(pasted.statusCode).toBe(200)
    // Pasting a client is not walking the wizard again: the step it reports is still 'done'.
    expect(pasted.json()).toEqual({ step: 'done' })
    expect(harness.app.haelan.stores.credentials.getClient()?.clientId)
      .toBe('id.apps.googleusercontent.com')

    // With a client stored, consent is the open door it has always been past 'done'.
    const start = await harness.app.inject({ method: 'GET', url: '/oauth/start', headers, cookies })
    expect(start.statusCode).toBe(302)
    expect(start.headers.location).toContain('client_id=id.apps.googleusercontent.com')

    // The exemption is those two paths, not the wizard reopening: the route that closed this
    // instance is still shut, which is what stops one being re-run from the phone alone.
    const again = await harness.app.inject({
      method: 'POST', url: '/api/setup/companion', headers, cookies, payload: {},
    })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: { kind: 'setup_incomplete', code: 'setup_complete' } })
  })

  it('keeps the client route shut on a companion instance that has since connected Google', async () => {
    harness = await withServer()
    const { cookies, personId } = await companionInstance(harness)
    // The member's own consent is how a companion instance ends up mixed. Written straight to the
    // store: this case is about the gate, not about the consent flow e2e-setup.test.ts walks.
    harness.app.haelan.instance.credentials.putRefreshToken({
      personId, refreshToken: 'stub-refresh-token', scopes: [...SCOPES], nowMs: harness.clock.nowMs,
    })

    const pasted = await harness.app.inject({
      method: 'POST', url: '/api/setup/google-client', headers, cookies,
      payload: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret' },
    })
    expect(pasted.statusCode).toBe(409)
    expect(pasted.json()).toMatchObject({ error: { kind: 'setup_incomplete', code: 'setup_complete' } })
    // Nothing was written: the refusal is the point, not a redirect to a form.
    expect(harness.app.haelan.stores.credentials.getClient()).toBeNull()
  })

  it('answers the failed-consent screen on a completed companion instance', async () => {
    harness = await withServer()
    const { cookies } = await companionInstance(harness)

    const before = await harness.app.inject({ method: 'GET', url: '/api/setup/last-error', headers, cookies })
    expect(before.statusCode).toBe(200)
    expect(before.json()).toEqual({ code: 'none', message: '' })

    // The callback is open past 'done' - consent outlives setup - and a failure redirects to the
    // screen that fetches the reason from the route above. No client is needed for the failure
    // branch: the error query is read before the client is.
    const failed = await harness.app.inject({
      method: 'GET', url: '/oauth/callback?error=access_denied', headers,
    })
    expect(failed.statusCode).toBe(302)
    expect(failed.headers.location).toBe('/setup/google?error=access_denied')

    const after = await harness.app.inject({ method: 'GET', url: '/api/setup/last-error', headers, cookies })
    expect(after.statusCode).toBe(200)
    expect(after.json()).toMatchObject({ code: 'access_denied' })
  })
})
