import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiGet, ApiError } from '../src/api/client.js'

const respond = (status: number, body: unknown) => new Response(
  body === undefined ? '' : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

afterEach(() => { vi.unstubAllGlobals() })

describe('the api client', () => {
  it('returns the parsed body on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { personId: 'p1' })))
    await expect(apiGet<{ personId: string }>('/api/v1/x')).resolves.toEqual({ personId: 'p1' })
  })

  // The distinction the whole class exists for: one of these sends the reader to sign in and the
  // other must not, so they cannot both surface as "request failed".
  it('reports a 401 as unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(401, { error: { kind: 'auth', code: 'no_session' } })))
    await expect(apiGet('/api/v1/x')).rejects.toMatchObject({ kind: 'unauthorized', status: 401 })
  })

  it('reports a network failure as unreachable, not as unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(apiGet('/api/v1/x')).rejects.toMatchObject({ kind: 'unreachable', status: null })
  })

  it('reports the 409 an empty instance answers with, which the wizard depends on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(409, { error: { kind: 'config', code: 'setup_incomplete' } })))
    await expect(apiGet('/api/v1/x')).rejects.toMatchObject({ kind: 'setup_incomplete' })
  })

  it('carries the server message through, because the server writes the useful one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(400, { error: { kind: 'config', code: 'bad_range', message: 'from is after to' } })))
    await expect(apiGet('/api/v1/x')).rejects.toThrow('from is after to')
  })

  it('is an ApiError, so a caller can narrow on it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(500, { error: { kind: 'transient', code: 'oops' } })))
    await expect(apiGet('/api/v1/x')).rejects.toBeInstanceOf(ApiError)
  })
})
