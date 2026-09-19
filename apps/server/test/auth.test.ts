import { describe, it, expect, afterEach } from 'vitest'
import { openHaelan, SESSION_LAST_SEEN_RESOLUTION_MS } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const headers = { origin: 'http://localhost:4235', host: 'localhost:4235' }

const login = (h: Harness, password = 'a good long password') => h.app.inject({
  method: 'POST', url: '/api/auth/login', headers, payload: { username: 'robin', password },
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
      payload: { username: 'robin', password: 'a good long password' },
    })
    expect(cookieFrom(response)?.secure).toBe(true)
  })

  it('answers 401 for a wrong password without saying which half was wrong', async () => {
    harness = await withServer()
    await harness.completeSetup()
    const response = await login(harness, 'wrong')
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: { kind: 'unauthorized', code: 'invalid_credentials', message: expect.any(String) },
    })
  })

  it('answers 423 once locked, which is a different fact from a wrong password', async () => {
    harness = await withServer()
    await harness.completeSetup()
    for (let i = 0; i < 10; i++) await login(harness, 'wrong')
    const response = await login(harness)
    expect(response.statusCode).toBe(423)
    expect(response.json()).toEqual({
      error: { kind: 'unauthorized', code: 'locked', message: expect.any(String) },
    })
  })

  it('refuses /api/auth/me without a session', async () => {
    harness = await withServer()
    await harness.connectPerson()
    expect((await harness.app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401)
  })

  it('answers /api/auth/me with the person the session belongs to', async () => {
    harness = await withServer()
    await harness.connectPerson()
    const cookie = cookieFrom(await login(harness))!
    const response = await harness.app.inject({
      method: 'GET', url: '/api/auth/me', cookies: { haelan_session: cookie.value },
    })
    expect(response.json()).toEqual({
      personId: 'p1', displayName: 'Robin', username: 'robin', isAdmin: true,
      timezone: 'Europe/Amsterdam', birthDate: null, sex: null,
      connected: true, credentialsUnreadable: false,
      baseUrl: 'http://localhost:4235',
    })
  })

  it('reports a person with no Google credentials as not connected', async () => {
    harness = await withServer()
    // p1 leaves the harness connected, so the unconnected case needs a member
    // of its own: addPerson creates one with no token behind it.
    await harness.addPerson({ id: 'p2', displayName: 'Other', username: 'other' })
    const token = await harness.signIn('other', 'a good long password')
    expect((await me(harness, token)).json()).toMatchObject({ connected: false })
  })

  it('reports a connected person as connected', async () => {
    harness = await withServer()
    await harness.connectPerson()
    const token = await harness.signIn()
    expect((await me(harness, token)).json()).toMatchObject({ connected: true })
  })

  // A revoked credentials row is not deleted (see CredentialStore.markRevoked), so this proves
  // "connected" reads the revocation, not merely whether a row exists - the same row that reports
  // true before revoke() must flip to false after it, distinct from a person who never had one.
  it('reports a revoked person as not connected', async () => {
    harness = await withServer()
    await harness.connectPerson()
    const token = await harness.signIn()
    // Revoked after the sign-in that connected them: signIn itself leaves a token,
    // so revoking first would prove nothing about the flag.
    harness.app.haelan.stores.credentials.markRevoked('p1', harness.clock.nowMs)
    expect((await me(harness, token)).json()).toMatchObject({ connected: false })
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
    await harness.connectPerson()
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
      payload: { username: 'robin', password: 'a good long password' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      error: { kind: 'forbidden', code: 'bad_origin', message: 'the origin header does not match this instance' },
    })
  })
})

/**
 * The outage 1.16.0 shipped, at the level the reader met it.
 *
 * DERIVATION_VERSION went to 8, so every instance rebuilt on boot. runRebuild rebuilds one person
 * inside a single transaction from its own process, so on a household of one SQLite's write lock
 * is held for the whole rebuild - up to fifteen minutes on real data. requireSession resolved a
 * session by writing to it, so every authenticated request waited out busy_timeout, threw
 * SQLITE_BUSY and became a 500, and the web app showed "this instance gave no answer" until the
 * rebuild committed.
 */
describe('an authenticated request while a rebuild holds the write lock', () => {
  it('is answered, and without sitting out the busy timeout', async () => {
    harness = await withServer({ rebuildInFlight: () => true })
    await harness.completeSetup()
    const token = await harness.signIn()
    // Past the lastSeen window, so this is the request that would want to write. Inside it the
    // route never reaches the write at all and the lock below would prove nothing.
    harness.clock.nowMs += SESSION_LAST_SEEN_RESOLUTION_MS

    const rebuild = openHaelan(harness.dir, {})
    try {
      // IMMEDIATE, so the lock is held now rather than at some first write later - which is what
      // a rebuild already partway through its transaction looks like to this process.
      rebuild.db.$client.exec('begin immediate')

      const started = performance.now()
      const response = await harness!.app.inject({
        method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` },
      })
      const elapsed = performance.now() - started

      expect(response.statusCode).toBe(200)
      // The half that a 200 alone does not cover. SessionStore's own guard already turns a refused
      // write into a resolved session, so this route answered 200 even before requireSession
      // learned to skip the write - it just took the five seconds better-sqlite3 sleeps in its
      // busy handler first, on the single thread every other request shares. An order of
      // magnitude below busy_timeout: wide enough for a loaded runner, far too tight to hide one.
      expect(elapsed).toBeLessThan(1000)
    } finally {
      rebuild.db.$client.exec('rollback')
      rebuild.close()
    }
  })
})
