import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

function seedDaily(h: Harness, input: {
  localDate: string, value: number, metric?: string, source?: string,
}): void {
  h.app.haelan.instance.db.insert(schema.daily).values({
    personId: 'p1', localDate: input.localDate, metric: input.metric ?? 'steps', agg: 'sum',
    source: input.source ?? 'merged', value: input.value, coverage: 0.9, sourceMix: null,
    derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
  }).run()
}

describe('GET /p/:personId/all-time', () => {
  it('answers the span, the records and the eddington number in one call', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-01-01', value: 9000 })
    seedDaily(harness, { localDate: '2026-01-02', value: 21000 })

    const response = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/all-time', headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.span).toMatchObject({ from: '2026-01-01', to: '2026-01-02', days: 2 })
    expect(body.records).toEqual([{
      metric: 'steps', tier: 'merged', localDate: '2026-01-02', value: 21000,
      from: '2026-01-01', days: 2,
    }])
    expect(body.eddington).toMatchObject({ from: '2026-01-01', days: 2 })
  })

  it('carries a metric that lives only in the provider tier, which is most of the point', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-01-01', value: 12, metric: 'floors', source: 'provider' })

    const response = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/all-time', headers: { authorization: `Bearer ${token}` },
    })
    expect(response.json().records).toEqual([{
      metric: 'floors', tier: 'provider', localDate: '2026-01-01', value: 12,
      from: '2026-01-01', days: 1,
    }])
  })

  it('takes no parameters, because the page it serves has no range', async () => {
    // A query string is not merely ignored, it is meaningless here: a caller passing one has
    // misunderstood the route, and the answer must be identical either way rather than quietly
    // filtered.
    harness = await withServer()
    const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-01-01', value: 9000 })
    const headers = { authorization: `Bearer ${token}` }

    const plain = await harness.app.inject({ method: 'GET', url: '/api/v1/p/p1/all-time', headers })
    const withRange = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/all-time?from=2026-01-01&to=2026-01-01', headers,
    })
    expect(withRange.statusCode).toBe(200)
    expect(withRange.json()).toEqual(plain.json())
  })

  it('answers an empty archive rather than failing on it', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const response = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/all-time', headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ records: [], eddington: null, milestones: [] })
  })
})
