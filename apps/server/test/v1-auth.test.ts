import { describe, it, expect, afterEach } from 'vitest'
import { bearerToken } from '../src/auth/bearer.ts'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

describe('bearerToken', () => {
  it('reads the token from a well formed header', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123')
  })

  // Case insensitive per RFC 7235. A client that sends "bearer" is not wrong.
  it('accepts any casing of the scheme', () => {
    expect(bearerToken('bearer abc123')).toBe('abc123')
    expect(bearerToken('BEARER abc123')).toBe('abc123')
  })

  it('ignores a scheme that is not bearer, rather than guessing', () => {
    expect(bearerToken('Basic abc123')).toBeNull()
  })

  it('returns null for a missing, empty or malformed header', () => {
    expect(bearerToken(undefined)).toBeNull()
    expect(bearerToken('')).toBeNull()
    expect(bearerToken('Bearer')).toBeNull()
    expect(bearerToken('Bearer ')).toBeNull()
  })

  // Fastify types a repeated header as an array. Two Authorization headers is a malformed
  // request, and picking one of them would be guessing which client meant what.
  it('returns null when the header arrived more than once', () => {
    expect(bearerToken(['Bearer a', 'Bearer b'])).toBeNull()
  })
})

describe('requireSession with a bearer token', () => {
  it('accepts a session id in the Authorization header', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const response = await harness.app.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().personId).toBe('p1')
  })

  it('still accepts the cookie, since the browser keeps using it', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const response = await harness.app.inject({
      method: 'GET', url: '/api/auth/me', cookies: { haelan_session: token },
    })
    expect(response.statusCode).toBe(200)
  })

  // The header wins, because a native client that sent one meant it. A stale cookie riding along
  // must not silently decide who the caller is.
  it('prefers the header when both are present', async () => {
    harness = await withServer()
    const mine = await harness.signIn()
    await harness.addPerson({ id: 'p2', displayName: 'Wilma', username: 'wilma' })
    const theirs = await harness.signIn('wilma')
    const response = await harness.app.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { authorization: `Bearer ${theirs}` },
      cookies: { haelan_session: mine },
    })
    expect(response.json().personId).toBe('p2')
  })

  it('rejects a bearer token that resolves to nothing', async () => {
    harness = await withServer()
    await harness.connectPerson()
    const response = await harness.app.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { authorization: 'Bearer not-a-session' },
    })
    expect(response.statusCode).toBe(401)
  })

  // Clearing a cookie the caller never sent is noise at best, and at worst it logs out a browser
  // session that happened to share the connection.
  it('does not clear the cookie when a bearer token failed', async () => {
    harness = await withServer()
    await harness.connectPerson()
    const response = await harness.app.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { authorization: 'Bearer not-a-session' },
    })
    expect(response.cookies.some((c) => c.name === 'haelan_session' && c.value === '')).toBe(false)
  })

  // The obvious "helpful" future change is to fall back to the cookie once the header fails to
  // resolve. That would authenticate the caller as whoever the cookie names, which is exactly the
  // identity the header just said they were not. A failed header must lose outright, not degrade
  // into the cookie, and it must not clear a cookie that was never at fault.
  it('rejects an invalid bearer token even alongside a valid cookie, and leaves the cookie alone', async () => {
    harness = await withServer()
    const mine = await harness.signIn()
    const response = await harness.app.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { authorization: 'Bearer not-a-session' },
      cookies: { haelan_session: mine },
    })
    expect(response.statusCode).toBe(401)
    expect(response.cookies.some((c) => c.name === 'haelan_session' && c.value === '')).toBe(false)
  })
})

describe('the shape a failed session check answers with', () => {
  // app.requireSession is the only session guard left; every family it sits in front of, flat or
  // versioned, admin gated or not, answers the same body on a missing session.
  it('answers the envelope on every route family, not only /api/v1', async () => {
    harness = await withServer()
    await harness.connectPerson()
    const urls = [
      '/api/auth/me',
      '/api/members',
      '/api/v1/p/p1/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-02',
    ]
    for (const url of urls) {
      const response = await harness.app.inject({ method: 'GET', url })
      expect(response.statusCode, url).toBe(401)
      expect(response.json(), url).toEqual({
        error: { kind: 'unauthorized', code: 'no_session', message: 'sign in required' },
      })
    }
  })
})
