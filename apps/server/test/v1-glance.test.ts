import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, insertSample, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

async function get(h: Harness, token: string, path: string) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/p/p1${path}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('GET /api/v1/p/:personId/glance', () => {
  it('answers the glance for the person\'s own today, in their own zone', async () => {
    harness = await withServer()
    // 23:30 UTC on 19 August is already 20 August in Europe/Amsterdam, every harness person's zone.
    // Set before signIn so the session's own expiry is stamped from the same instant the request
    // below runs at, rather than from the harness's default clock thirty-plus days earlier.
    harness.clock.nowMs = Date.parse('2026-08-19T23:30:00Z')
    const token = await harness.signIn()
    const reply = await get(harness, token, '/glance')
    expect(reply.statusCode).toBe(200)
    const body = reply.json()
    expect(body.today).toBe('2026-08-20')
    expect(body).toHaveProperty('recovery.index')
    expect(body).toHaveProperty('day.steps')
  })

  // The route rebuilds `day` to round its figures, and a rebuild that named its fields one by one
  // would drop any it did not know about. Today's workouts have nothing to round and must survive.
  it('carries today\'s workouts through, merged across the sources that recorded them', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T10:00:00Z')
    const token = await harness.signIn()
    const db = harness.app.haelan.instance.db
    for (const id of ['google', 'phone']) {
      db.insert(schema.sources).values({ id, personId: 'p1', externalId: id, displayName: id, kind: 'device', createdAtMs: 0 }).run()
    }
    const startMs = Date.parse('2026-08-20T06:00:00Z')
    for (const [id, sourceId] of [['google-run', 'google'], ['phone-run', 'phone']] as const) {
      db.insert(schema.sessions).values({
        id, personId: 'p1', sourceId, kind: 'exercise', externalId: id,
        startMs, startOffsetMinutes: 120, endMs: startMs + 30 * 60_000, endOffsetMinutes: 120,
        localDate: '2026-08-20', attrs: JSON.stringify({ exerciseType: 'RUNNING' }), rawPayloadId: null,
      }).run()
    }

    const body = (await get(harness, token, '/glance')).json()
    expect(body.day.workouts.map((w: { id: string, alternateIds: string[] }) => [w.id, w.alternateIds]))
      .toEqual([['google-run', ['phone-run']]])
  })

  it('answers 304 to a repeat request carrying the first one\'s ETag, a minute later', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const first = await get(harness, token, '/glance')
    expect(first.statusCode).toBe(200)
    // A minute on, same day, same rows. Moving the clock is the point: anything time-of-request
    // in the hashed body would change the ETag, and the harness clock otherwise stands still.
    harness.clock.nowMs += 60_000
    const again = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/glance',
      headers: { authorization: `Bearer ${token}`, 'if-none-match': first.headers.etag as string },
    })
    expect(again.statusCode).toBe(304)
  })

  it('rounds every figure to its metric\'s catalogue precision, as /series and /intraday do', async () => {
    harness = await withServer()
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const db = harness.app.haelan.instance.db
    db.insert(schema.sources).values({ id: 'w1', personId: 'p1', externalId: 'w1', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
    const row = (metric: string, localDate: string, value: number) => db.insert(schema.daily).values({
      personId: 'p1', localDate, metric, agg: 'sum', source: 'merged', value, coverage: 1, sourceMix: null,
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
    // Sixty days alternating 1000.4 and 2000.9: a centre of 1500.65 and a fractional spread, so
    // the band's three numbers all arrive unrounded unless the route rounds them.
    for (let i = 0; i < 60; i += 1) {
      const localDate = new Date(Date.parse('2026-08-19T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10)
      row('steps', localDate, i % 2 === 0 ? 1000.4 : 2000.9)
    }
    row('steps', '2026-08-20', 1234.6)
    row('active_minutes_light', '2026-08-20', 12.7)
    insertSample(db, {
      personId: 'p1', sourceId: 'w1', metric: 'heart_rate', utcMs: Date.parse('2026-08-20T07:30:00Z'),
      tzOffsetMinutes: 120, agg: 'mean', value: 64.4,
    })
    const body = (await get(harness, token, '/glance')).json()
    const { steps } = body.day
    expect(steps.value).toBe(1235)
    for (const n of [steps.baseline.center, steps.baseline.low, steps.baseline.high]) expect(Number.isInteger(n)).toBe(true)
    expect(steps.strip.at(-2).value).toBe(1000)
    expect(body.day.activeMinutes.value).toBe(13)
    expect(body.day.heartRate.points[0].mean).toBe(64)
  })

  it('names a stale source that fed the figure before it went quiet, by the name the person gave it', async () => {
    harness = await withServer()
    // Set before signIn for the same reason the first case does.
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const db = harness.app.haelan.instance.db
    db.insert(schema.sources).values({ id: 'w1', personId: 'p1', externalId: 'w1', displayName: 'FITBIT', kind: 'device', createdAtMs: 0 }).run()
    db.insert(schema.sources).values({ id: 'ph', personId: 'p1', externalId: 'ph', displayName: 'Phone', kind: 'device', createdAtMs: 0 }).run()
    harness.app.haelan.instance.sourceAliases.put({ personId: 'p1', sourceId: 'w1', alias: 'My watch', nowMs: harness.clock.nowMs })
    const row = (localDate: string, source: string, sourceMix: string | null) => db.insert(schema.daily).values({
      personId: 'p1', localDate, metric: 'steps', agg: 'sum', source, value: 1000, coverage: 1, sourceMix,
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
    const mix = (...ids: string[]) => JSON.stringify(ids.map((source) => ({ source, share: 1 / ids.length })))
    // The shape derivation writes when a device stops: the watch and the phone both report through
    // July, and each day's merged row names both; from August on only the phone reports, and the
    // merged rows name only it. Nothing in the last week mentions the watch.
    for (let d = 1; d <= 31; d += 1) {
      const localDate = `2026-07-${String(d).padStart(2, '0')}`
      row(localDate, 'w1', null)
      row(localDate, 'ph', null)
      row(localDate, 'merged', mix('w1', 'ph'))
    }
    for (let d = 1; d <= 20; d += 1) {
      const localDate = `2026-08-${String(d).padStart(2, '0')}`
      row(localDate, 'ph', null)
      row(localDate, 'merged', mix('ph'))
    }
    const body = (await get(harness, token, '/glance')).json()
    // Exactly the watch: the phone fed the same figure and is still reporting.
    expect(body.day.steps.staleSources).toEqual([expect.objectContaining({ sourceId: 'w1', name: 'My watch' })])
  })
})
