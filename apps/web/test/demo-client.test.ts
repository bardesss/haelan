import { describe, it, expect, afterEach, vi } from 'vitest'
import { ApiError } from '../src/api/apiError.js'
import { createDemoTransport, loadFromBundle } from '../src/demo/client.js'

const MANIFEST = {
  '/api/auth/me': 'me.json',
  '/api/v1/p/demo/series?agg=sum&from=2026-09-01&metric=steps&to=2026-09-07': 'series.json',
}

const FILES: Record<string, unknown> = {
  'manifest.json': MANIFEST,
  'me.json': { personId: 'demo', displayName: 'Demo' },
  'series.json': { series: { steps: { points: [{ date: '2026-09-01', value: 8123 }] } } },
}

function transport() {
  return createDemoTransport(async (file: string) => {
    if (!(file in FILES)) throw new Error(`the test asked for ${file}, which it does not have`)
    return FILES[file]
  })
}

describe('the demo transport', () => {
  it('answers a recorded url from the manifest', async () => {
    const body = await transport().apiGet<{ personId: string }>('/api/auth/me')
    expect(body.personId).toBe('demo')
  })

  it('answers a url spelled differently from the one recorded', async () => {
    // The page builds its query in its own order; the recorder wrote one canonical spelling.
    // This is the guarantee canonicalUrl exists for, asserted where it actually matters.
    const body = await transport().apiGet<{ series: Record<string, unknown> }>(
      '/api/v1/p/demo/series?metric=steps&to=2026-09-07&agg=sum&from=2026-09-01',
    )
    expect(Object.keys(body.series)).toEqual(['steps'])
  })

  it('throws a not_found ApiError for a url nobody recorded', async () => {
    const error = await transport().apiGet('/api/v1/p/demo/series?agg=sum&metric=unicorns')
      .then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).kind).toBe('not_found')
    // The UI already renders this kind. A hang or an empty body would render as a broken page.
    expect((error as ApiError).status).toBe(404)
  })

  it('is an Error, so existing catch blocks behave', async () => {
    const error = await transport().apiGet('/nope').then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(Error)
  })

  it('loads the manifest once however many reads happen', async () => {
    let loads = 0
    const counted = createDemoTransport(async (file: string) => {
      if (file === 'manifest.json') loads += 1
      return FILES[file]
    })
    await counted.apiGet('/api/auth/me')
    await counted.apiGet('/api/auth/me')
    expect(loads).toBe(1)
  })

  it('retries the manifest after a failed load, instead of caching the rejection forever', async () => {
    // A cached rejected promise would fail every read for the rest of the session on a problem
    // that may have already gone away - this proves the second read gets a fresh attempt rather
    // than the first attempt's stale failure.
    let attempts = 0
    const flaky = createDemoTransport(async (file: string) => {
      if (file === 'manifest.json') {
        attempts += 1
        if (attempts === 1) throw new Error('transient host hiccup')
        return MANIFEST
      }
      return FILES[file]
    })

    await expect(flaky.apiGet('/api/auth/me')).rejects.toThrow('transient host hiccup')
    const body = await flaky.apiGet<{ personId: string }>('/api/auth/me')
    expect(body.personId).toBe('demo')
    expect(attempts).toBe(2)
  })
})

describe('loadFromBundle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('turns a thrown fetch into an unreachable ApiError, not a raw error', async () => {
    // An ad blocker, an aborted navigation, or the static host simply not answering - a thrown
    // fetch is never a status, and api/client.ts's own apiSend treats it the same way.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network request failed')))

    const error = await loadFromBundle('manifest.json').then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).kind).toBe('unreachable')
  })

  it('turns a body that will not parse into a transient ApiError, not unreachable', async () => {
    // A corrupt or truncated fixture that still shipped with the build - the host answered, so
    // this is a different failure than the network never responding, and must not claim to be one.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    }))

    const error = await loadFromBundle('manifest.json').then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    // The concrete kind client.ts's own comment documents for this failure, not merely "anything
    // but unreachable": that weaker assertion would stay green even if this path regressed to a
    // third, wrong kind instead of the two it is meant to choose between.
    expect((error as ApiError).kind).toBe('transient')
  })
})
