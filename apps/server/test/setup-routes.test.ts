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
    username: 'bartus', password: 'a good long password',
    displayName: 'Bartus', timezone: 'Europe/Amsterdam', ...overrides,
  },
})

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
    expect(String(response.json().error)).toContain('timezone')
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
    await createAccount(harness)
    const response = await harness.app.inject({
      method: 'POST', url: '/api/setup/instance-url', headers,
      payload: { baseUrl: 'http://localhost:4235', consentPath: 'localhost' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      step: 'google-client', redirectUri: 'http://localhost:4235/oauth/callback',
    })
  })

  it('refuses an instance URL that could never be registered', async () => {
    harness = await withServer()
    await createAccount(harness)
    const response = await harness.app.inject({
      method: 'POST', url: '/api/setup/instance-url', headers,
      payload: { baseUrl: 'http://192.168.178.82:4235', consentPath: 'proxy' },
    })
    expect(response.statusCode).toBe(400)
    expect(String(response.json().error)).toContain('raw IP addresses')
  })

  it('lists concrete candidates and never a placeholder', async () => {
    harness = await withServer()
    await createAccount(harness)
    const response = await harness.app.inject({
      method: 'GET', url: '/api/setup/redirect-uris?host=box.tail1234.ts.net', headers,
    })
    const body = response.json() as { candidates: Array<{ uri: string }> }
    expect(body.candidates.map((c) => c.uri)).toContain('https://box.tail1234.ts.net/oauth/callback')
    for (const candidate of body.candidates) expect(candidate.uri).not.toMatch(/[<>]/)
  })

  it('serves the scopes the consent screen has to declare, complete and copyable', async () => {
    harness = await withServer()
    await createAccount(harness)
    const response = await harness.app.inject({ method: 'GET', url: '/api/setup/scopes', headers })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { scopes: string[] }
    // Six, because the wizard's copy says six. A list that disagreed with the number in the
    // instructions would send somebody to the console to declare the wrong set.
    expect(body.scopes).toHaveLength(6)
    for (const scope of body.scopes) {
      expect(scope.startsWith('https://www.googleapis.com/auth/googlehealth.')).toBe(true)
    }
  })

  it('asks Google for exactly the scopes it told the owner to declare', async () => {
    harness = await withServer()
    await createAccount(harness)
    const listed = (await harness.app.inject({
      method: 'GET', url: '/api/setup/scopes', headers,
    })).json() as { scopes: string[] }
    // The failure this prevents: declaring five in the console because the wizard listed five,
    // then failing at consent because the request asked for six. One array, two readers.
    expect([...SCOPES].sort()).toEqual([...listed.scopes].sort())
  })

  it('refuses the setup routes once setup is finished', async () => {
    harness = await withServer()
    await harness.completeSetup()
    const response = await createAccount(harness)
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'setup_complete' })
  })
})
