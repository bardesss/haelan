import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiGet, ApiError } from '../src/api/client.js'

const respond = (status: number, body: unknown) => new Response(
  body === undefined ? '' : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

// Stubs fetch and hands back the rejection itself, so a test can assert on individual fields of
// the ApiError rather than repeating the stub/await/catch boilerplate at every call site. Throws
// rather than silently returning undefined if apiGet does not reject, so a broken stub fails loud.
const rejection = async (status: number, body: unknown): Promise<ApiError> => {
  vi.stubGlobal('fetch', vi.fn(async () => respond(status, body)))
  try {
    await apiGet('/api/v1/x')
    throw new Error('expected apiGet to reject')
  } catch (error) {
    return error as ApiError
  }
}

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
    // setupGate.ts sends this exact kind/code pair for a /api/v1/* route it blocks.
    vi.stubGlobal('fetch', vi.fn(async () => respond(409, { error: { kind: 'setup_incomplete', code: 'setup_incomplete' } })))
    await expect(apiGet('/api/v1/x')).rejects.toMatchObject({ kind: 'setup_incomplete' })
  })

  it('carries the server message through, because the server writes the useful one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(400, { error: { kind: 'config', code: 'bad_range', message: 'from is after to' } })))
    await expect(apiGet('/api/v1/x')).rejects.toThrow('from is after to')
  })

  it('is an ApiError, so a caller can narrow on it', async () => {
    // The body a real 500 carries: sendCoreError's unrecognised-throw branch in envelope.ts always
    // answers 'internal', never 'transient' - a server 500 with a transient kind does not occur.
    vi.stubGlobal('fetch', vi.fn(async () => respond(500, { error: { kind: 'internal', code: 'internal_error', message: 'something went wrong' } })))
    await expect(apiGet('/api/v1/x')).rejects.toBeInstanceOf(ApiError)
  })

  // The distinction the whole field exists for: the status alone cannot tell a deterministic 500
  // from a transient one, which is exactly why envelope.ts puts 'internal' in the body at all.
  it('takes the kind from the envelope when the server sends one', async () => {
    const error = await rejection(500, { error: { kind: 'internal', code: 'internal_error', message: 'something went wrong' } })
    expect(error.kind).toBe('internal')
  })

  it('still maps by status when the body carries no kind', async () => {
    const error = await rejection(500, {})
    expect(error.kind).toBe('transient')
  })

  it('ignores a kind the client does not know', async () => {
    const error = await rejection(500, { error: { kind: 'not_a_kind', message: 'x' } })
    expect(error.kind).toBe('transient')
  })

  // 'unreachable' is a thrown-fetch-only kind (see the ApiError above for the network-failure
  // case): a body spelling it must not be believed, or a slow instance's own 500 would be read
  // back as the network being down and mask the real failure.
  it('does not accept unreachable from a response body', async () => {
    const error = await rejection(500, { error: { kind: 'unreachable', message: 'x' } })
    expect(error.kind).toBe('transient')
  })

  it('reports a 502 with an HTML body as transient, not unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><body>Bad Gateway</body></html>',
      { status: 502, headers: { 'content-type': 'text/html' } },
    )))
    await expect(apiGet('/api/v1/x')).rejects.toMatchObject({ kind: 'transient', status: 502 })
  })

  it('wraps a SyntaxError from malformed error body as an ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'not json at all',
      { status: 502, headers: { 'content-type': 'text/plain' } },
    )))
    const error = await apiGet('/api/v1/x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).kind).toBe('transient')
    expect((error as ApiError).status).toBe(502)
  })

  it('wraps a SyntaxError from malformed success body as an ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'not json at all',
      { status: 200, headers: { 'content-type': 'text/plain' } },
    )))
    const error = await apiGet('/api/v1/x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).kind).toBe('transient')
    expect((error as ApiError).status).toBe(200)
  })
})
