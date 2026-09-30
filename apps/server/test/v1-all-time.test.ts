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
      from: '2026-01-01', days: 2, sourceName: null, sourceDefaultName: null,
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
      from: '2026-01-01', days: 1, sourceName: null, sourceDefaultName: null,
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
    expect(response.json()).toMatchObject({
      records: [], sessionRecords: [], eddington: null, milestones: [],
    })
  })

  // One straight 6 km run at 3 m/s: the GPS fastest kilometre is 333.33 s, the mile 536.4 and the
  // 5 km 1666.67, and a record's seconds go out whole, as the workout page's efforts do.
  it('sends the GPS records in whole seconds', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const db = harness.app.haelan.instance.db
    db.insert(schema.sources).values({ id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0 }).run()
    const startMs = Date.UTC(2026, 8, 4, 5, 0)
    db.insert(schema.sessions).values({
      id: 'run', personId: 'p1', sourceId: 'watch', kind: 'exercise', externalId: 'run',
      startMs, startOffsetMinutes: 120, endMs: startMs + 2_000_000, endOffsetMinutes: 120,
      localDate: '2026-09-04', rawPayloadId: null,
      attrs: JSON.stringify({
        type: null, mainSleep: null, stagesStatus: null, summary: null, shortAwakenings: null,
        splitSummaries: null, exerciseEvents: null, displayName: null, notes: null, routeConsentRequired: null,
        exerciseMetadata: { hasGps: true }, exerciseType: 'RUNNING', metricsSummary: null, splits: null, activeDuration: null,
      }),
    }).run()
    const metresPerDegree = (6_371_000 * Math.PI) / 180
    db.insert(schema.sessionRoutes).values(Array.from({ length: 21 }, (_, i) => ({
      id: `run-${i}`, sessionId: 'run', ordinal: i, atMs: startMs + i * 100_000,
      latitude: 52 + (i * 300) / metresPerDegree, longitude: 5,
      altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
    }))).run()

    const response = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/all-time', headers: { authorization: `Bearer ${token}` },
    })
    const records = response.json().sessionRecords as { category: string, kind: string, value: number }[]
    const byKind = Object.fromEntries(records.map((r) => [r.kind, r.value]))
    expect(byKind['fastest-1k']).toBe(333)
    expect(byKind['fastest-mile']).toBe(536)
    expect(byKind['fastest-5k']).toBe(1667)
    // Every record is the run category's, and says so.
    expect(new Set(records.map((r) => r.category))).toEqual(new Set(['run']))
    expect(response.body).not.toMatch(/latitude|longitude/)
  })
})
