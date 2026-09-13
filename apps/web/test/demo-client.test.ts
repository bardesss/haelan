import { describe, it, expect } from 'vitest'
import { ApiError } from '../src/api/apiError.js'
import { createDemoTransport } from '../src/demo/client.js'

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
})
