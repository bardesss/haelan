import { describe, it, expect, afterEach } from 'vitest'
import { insertSample, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const MINUTE = 60_000
const HOUR = 3_600_000
const OFFSET_MINUTES = 120
// 22:00Z on the 18th is 00:00 local on the 19th, so every window below straddles local midnight.
const BEDTIME = Date.UTC(2026, 7, 18, 22, 0)

async function get(h: Harness, token: string, path: string) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/p/p1${path}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

function seedSource(h: Harness, sourceId: string): void {
  h.app.haelan.instance.db.insert(schema.sources).values({
    id: sourceId, personId: 'p1', externalId: sourceId, displayName: sourceId,
    kind: 'device', createdAtMs: 0,
  }).onConflictDoNothing().run()
}

function seedHr(h: Harness, input: { atMs: number, value: number, sourceId?: string }): void {
  const sourceId = input.sourceId ?? 'watch'
  seedSource(h, sourceId)
  insertSample(h.app.haelan.instance.db, {
    personId: 'p1', sourceId, metric: 'heart_rate',
    utcMs: input.atMs, tzOffsetMinutes: OFFSET_MINUTES, agg: 'mean', value: input.value,
  })
}

const windowPath = (o: { startMs: number, endMs: number, extra?: string }) =>
  `/intraday/window?metric=heart_rate&startMs=${o.startMs}&endMs=${o.endMs}${o.extra ?? ''}`

describe('GET /intraday/window', () => {
  it('answers the readings in the window, across local midnight', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedHr(harness, { atMs: BEDTIME - MINUTE, value: 50 })
    seedHr(harness, { atMs: BEDTIME + 60 * MINUTE, value: 55 })
    seedHr(harness, { atMs: BEDTIME + 180 * MINUTE, value: 52 })

    const res = await get(harness, token, windowPath({ startMs: BEDTIME, endMs: BEDTIME + 8 * HOUR }))

    expect(res.statusCode).toBe(200)
    expect(res.json().points.map((p: { mean: number }) => p.mean)).toEqual([55, 52])
  })

  it('returns a point per source, each carrying its sourceId', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedHr(harness, { atMs: BEDTIME + MINUTE, value: 60, sourceId: 'watch' })
    seedHr(harness, { atMs: BEDTIME + MINUTE, value: 61, sourceId: 'phone' })

    const points = (await get(harness, token, windowPath({ startMs: BEDTIME, endMs: BEDTIME + HOUR }))).json().points
    expect(points).toHaveLength(2)
    expect(points.map((p: { sourceId: string }) => p.sourceId).sort()).toEqual(['phone', 'watch'])
  })

  it('filters to one source when asked', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedHr(harness, { atMs: BEDTIME + MINUTE, value: 60, sourceId: 'watch' })
    seedHr(harness, { atMs: BEDTIME + MINUTE, value: 61, sourceId: 'phone' })

    const points = (await get(harness, token,
      windowPath({ startMs: BEDTIME, endMs: BEDTIME + HOUR, extra: '&source=watch' }))).json().points
    expect(points).toHaveLength(1)
    expect(points[0].sourceId).toBe('watch')
  })

  it('refuses a missing bound with a 400 naming it', async () => {
    harness = await withServer(); const token = await harness.signIn()

    const res = await get(harness, token, `/intraday/window?metric=heart_rate&startMs=${BEDTIME}`)

    expect(res.statusCode).toBe(400)
    expect(res.json().error.kind).toBe('config')
    expect(res.json().error.message).toContain('endMs')
  })

  it('refuses a bound that is not a number', async () => {
    harness = await withServer(); const token = await harness.signIn()

    const res = await get(harness, token, `/intraday/window?metric=heart_rate&startMs=yesterday&endMs=${BEDTIME}`)

    expect(res.statusCode).toBe(400)
    expect(res.json().error.kind).toBe('config')
  })

  it('refuses a window wider than 48 hours, naming the limit', async () => {
    harness = await withServer(); const token = await harness.signIn()

    const res = await get(harness, token, windowPath({ startMs: BEDTIME, endMs: BEDTIME + 49 * HOUR }))

    expect(res.statusCode).toBe(400)
    // Longer than any night and any workout. The message says what to ask for instead, the way
    // requireBoundedRange's does.
    expect(res.json().error.message).toContain('48')
  })

  it('accepts a window of exactly 48 hours', async () => {
    harness = await withServer(); const token = await harness.signIn()

    const res = await get(harness, token, windowPath({ startMs: BEDTIME, endMs: BEDTIME + 48 * HOUR }))
    expect(res.statusCode).toBe(200)
  })

  it('refuses a window that ends before it starts', async () => {
    harness = await withServer(); const token = await harness.signIn()

    const res = await get(harness, token, windowPath({ startMs: BEDTIME, endMs: BEDTIME - HOUR }))
    expect(res.statusCode).toBe(400)
  })

  it('rounds values to the metric precision at the boundary', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedHr(harness, { atMs: BEDTIME + MINUTE, value: 60.4444 })

    const points = (await get(harness, token, windowPath({ startMs: BEDTIME, endMs: BEDTIME + HOUR }))).json().points
    // Heart rate's own precision, applied here and not inside the reader, so thinning still picks
    // its band edges from the real stored values. Whatever roundMetricValue answers for
    // heart_rate is what this must equal; read shared.ts and assert that number, not a substring.
    expect(points[0].mean).toBe(60)
  })

  it('answers an empty window with no points and a null reduction', async () => {
    harness = await withServer(); const token = await harness.signIn()

    const body = (await get(harness, token, windowPath({ startMs: BEDTIME, endMs: BEDTIME + HOUR }))).json()
    expect(body.points).toEqual([])
    expect(body.reduction).toBeNull()
  })

  it('sets a weak ETag and answers 304 when it is sent back', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedHr(harness, { atMs: BEDTIME + MINUTE, value: 60 })

    const path = `/api/v1/p/p1${windowPath({ startMs: BEDTIME, endMs: BEDTIME + HOUR })}`
    const first = await harness.app.inject({
      method: 'GET', url: path, headers: { authorization: `Bearer ${token}` },
    })
    const second = await harness.app.inject({
      method: 'GET', url: path,
      headers: { authorization: `Bearer ${token}`, 'if-none-match': String(first.headers.etag) },
    })
    expect(second.statusCode).toBe(304)
  })
})
