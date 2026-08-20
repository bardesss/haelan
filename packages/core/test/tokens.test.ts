import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { CredentialStore } from '../src/store/credentials.ts'
import { TokenProvider, RevokedError } from '../src/api/tokens.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

const KEY = Buffer.alloc(32, 5)

const okResponse = (accessToken: string, expiresIn = 3600) =>
  new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), { status: 200 })

describe('TokenProvider', () => {
  let ctx: TestDatabase
  let store: CredentialStore

  beforeEach(() => {
    ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    store = new CredentialStore(ctx.db, KEY)
    store.putClient({ clientId: 'cid', clientSecret: 'secret', nowMs: 0 })
    store.putRefreshToken({ personId: 'p1', refreshToken: 'rt', scopes: [], nowMs: 0 })
  })
  afterEach(() => { ctx.cleanup(); vi.restoreAllMocks() })

  it('exchanges the refresh token for an access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('at-1'))
    const provider = new TokenProvider(store, { fetch: fetchMock, now: () => 1000 })
    expect(await provider.accessTokenFor('p1')).toBe('at-1')
  })

  it('reuses a live token instead of refreshing on every call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('at-1'))
    const provider = new TokenProvider(store, { fetch: fetchMock, now: () => 1000 })
    await provider.accessTokenFor('p1')
    await provider.accessTokenFor('p1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes again once the token is close to expiry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse('at-1', 60))
      .mockResolvedValueOnce(okResponse('at-2', 3600))
    let now = 1000
    const provider = new TokenProvider(store, { fetch: fetchMock, now: () => now })
    expect(await provider.accessTokenFor('p1')).toBe('at-1')
    now += 59_000
    expect(await provider.accessTokenFor('p1')).toBe('at-2')
  })

  it('keeps one person token separate from another', async () => {
    seedPerson(ctx.db, 'p2')
    store.putRefreshToken({ personId: 'p2', refreshToken: 'rt2', scopes: [], nowMs: 0 })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse('at-p1'))
      .mockResolvedValueOnce(okResponse('at-p2'))
    const provider = new TokenProvider(store, { fetch: fetchMock, now: () => 1000 })
    expect(await provider.accessTokenFor('p1')).toBe('at-p1')
    expect(await provider.accessTokenFor('p2')).toBe('at-p2')
  })

  it('marks the person revoked on invalid_grant and pauses only them', async () => {
    seedPerson(ctx.db, 'p2')
    store.putRefreshToken({ personId: 'p2', refreshToken: 'rt2', scopes: [], nowMs: 0 })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    )
    const provider = new TokenProvider(store, { fetch: fetchMock, now: () => 7000 })
    await expect(provider.accessTokenFor('p1')).rejects.toBeInstanceOf(RevokedError)
    expect(store.getRefreshToken('p1')?.revokedAtMs).toBe(7000)
    expect(store.listConnectedPeople()).toEqual(['p2'])
  })

  it('does not mark revoked on a transient failure, because the grant is still good', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('upstream is sad', { status: 503 }))
    const provider = new TokenProvider(store, { fetch: fetchMock, now: () => 7000 })
    await expect(provider.accessTokenFor('p1')).rejects.not.toBeInstanceOf(RevokedError)
    expect(store.getRefreshToken('p1')?.revokedAtMs).toBeNull()
  })

  it('refuses a person whose credentials are already revoked', async () => {
    store.markRevoked('p1', 500)
    const fetchMock = vi.fn()
    const provider = new TokenProvider(store, { fetch: fetchMock, now: () => 1000 })
    await expect(provider.accessTokenFor('p1')).rejects.toBeInstanceOf(RevokedError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the person client override when one is configured', async () => {
    store.putClientOverride({ personId: 'p1', clientId: 'own', clientSecret: 'own-secret' })
    const fetchMock = vi.fn().mockResolvedValue(okResponse('at-1'))
    const provider = new TokenProvider(store, { fetch: fetchMock, now: () => 1000 })
    await provider.accessTokenFor('p1')
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams
    expect(body.get('client_id')).toBe('own')
  })

  it('refuses a cached token once revoked elsewhere, instead of serving it for up to an hour', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('at-1'))
    const provider = new TokenProvider(store, { fetch: fetchMock, now: () => 1000 })
    await provider.accessTokenFor('p1')
    store.markRevoked('p1', 1500)
    await expect(provider.accessTokenFor('p1')).rejects.toBeInstanceOf(RevokedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes for real after a revoke, clear and reconnect, rather than the pre-revocation token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse('at-1'))
    const provider = new TokenProvider(store, { fetch: fetchMock, now: () => 1000 })
    await provider.accessTokenFor('p1')
    store.markRevoked('p1', 1500)
    await expect(provider.accessTokenFor('p1')).rejects.toBeInstanceOf(RevokedError)
    store.clearRevoked('p1')
    store.putRefreshToken({ personId: 'p1', refreshToken: 'rt-new', scopes: [], nowMs: 2000 })
    fetchMock.mockResolvedValueOnce(okResponse('at-2'))
    expect(await provider.accessTokenFor('p1')).toBe('at-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not revoke on an unrelated error whose description merely mentions invalid_grant', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'invalid_request', error_description: 'looks like invalid_grant to a substring match' }),
        { status: 400 },
      ),
    )
    const provider = new TokenProvider(store, { fetch: fetchMock, now: () => 7000 })
    await expect(provider.accessTokenFor('p1')).rejects.not.toBeInstanceOf(RevokedError)
    expect(store.getRefreshToken('p1')?.revokedAtMs).toBeNull()
  })

  it('rejects a malformed token response rather than caching an undefined access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }))
    const provider = new TokenProvider(store, { fetch: fetchMock, now: () => 1000 })
    await expect(provider.accessTokenFor('p1')).rejects.toThrow(/malformed/)
  })
})
