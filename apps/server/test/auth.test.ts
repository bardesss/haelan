import { describe, it, expect, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const headers = { origin: 'http://localhost:4235', host: 'localhost:4235' }

const login = (h: Harness, password = 'a good long password') => h.app.inject({
  method: 'POST', url: '/api/auth/login', headers, payload: { username: 'bartus', password },
})

const cookieFrom = (response: { cookies: Array<{ name: string, value: string, secure?: boolean }> }) =>
  response.cookies.find((c) => c.name === 'haelan_session')

const me = (h: Harness, token: string) => h.app.inject({
  method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` },
})

describe('auth', () => {
  it('hands back a session cookie that is httpOnly, lax and rooted at /', async () => {
    harness = await withServer()
    await harness.completeSetup()
    const response = await login(harness)
    expect(response.statusCode).toBe(200)
    const cookie = response.cookies.find((c) => c.name === 'haelan_session')
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax')
    expect(cookie?.path).toBe('/')
  })

  it('does not set Secure over plain http, because the browser would then drop the cookie', async () => {
    harness = await withServer()
    await harness.completeSetup()
    // Spec section 15 puts the trust boundary at the LAN. A Secure cookie over http is not a
    // stronger instance, it is an instance nobody can log in to.
    expect(cookieFrom(await login(harness))?.secure).toBeFalsy()
  })

  it('sets Secure when a proxy says the browser used https', async () => {
    harness = await withServer()
    await harness.completeSetup()
    const response = await harness.app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: {
        'x-forwarded-proto': 'https',
        origin: 'https://box.tail1234.ts.net', host: 'box.tail1234.ts.net',
      },
      payload: { username: 'bartus', password: 'a good long password' },
    })
    expect(cookieFrom(response)?.secure).toBe(true)
  })

  it('answers 401 for a wrong password without saying which half was wrong', async () => {
    harness = await withServer()
    await harness.completeSetup()
    const response = await login(harness, 'wrong')
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'invalid_credentials' })
  })

  it('answers 423 once locked, which is a different fact from a wrong password', async () => {
    harness = await withServer()
    await harness.completeSetup()
    for (let i = 0; i < 10; i++) await login(harness, 'wrong')
    const response = await login(harness)
    expect(response.statusCode).toBe(423)
    expect(response.json()).toEqual({ error: 'locked' })
  })

  it('refuses /api/auth/me without a session', async () => {
    harness = await withServer()
    await harness.completeSetup()
    expect((await harness.app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401)
  })

  it('answers /api/auth/me with the person the session belongs to', async () => {
    harness = await withServer()
    await harness.completeSetup()
    const cookie = cookieFrom(await login(harness))!
    const response = await harness.app.inject({
      method: 'GET', url: '/api/auth/me', cookies: { haelan_session: cookie.value },
    })
    expect(response.json()).toEqual({
      personId: 'p1', displayName: 'Bartus', username: 'bartus', isAdmin: true,
      timezone: 'Europe/Amsterdam', connected: false, baseUrl: 'http://localhost:4235',
    })
  })

  it('reports a person with no Google credentials as not connected', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    expect((await me(harness, token)).json()).toMatchObject({ connected: false })
  })

  it('reports a connected person as connected', async () => {
    harness = await withServer()
    await harness.connectPerson()
    const token = await harness.signIn()
    expect((await me(harness, token)).json()).toMatchObject({ connected: true })
  })

  // The client compares this against its own origin to decide whether consent can succeed at all.
  it('carries the instance base URL', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    expect((await me(harness, token)).json().baseUrl).toBe('http://localhost:4235')
  })

  // Every local date in this system is the person's, not the viewer's. The browser needs the
  // person's zone to work out which day "today" is, and a laptop in another timezone must not
  // change which day a page opens on.
  it('returns the person timezone, so the browser can resolve the person own today', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const response = await harness.app.inject({
      method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().timezone).toBe('Europe/Amsterdam')
  })

  it('makes logout immediate rather than eventual', async () => {
    harness = await withServer()
    await harness.completeSetup()
    const cookie = cookieFrom(await login(harness))!
    await harness.app.inject({
      method: 'POST', url: '/api/auth/logout', headers, cookies: { haelan_session: cookie.value },
    })
    const after = await harness.app.inject({
      method: 'GET', url: '/api/auth/me', cookies: { haelan_session: cookie.value },
    })
    expect(after.statusCode).toBe(401)
  })

  it('rejects a mutating request whose Origin is a different host', async () => {
    harness = await withServer()
    await harness.completeSetup()
    const response = await harness.app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: 'http://evil.example', host: 'localhost:4235' },
      payload: { username: 'bartus', password: 'a good long password' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'bad_origin' })
  })
})
