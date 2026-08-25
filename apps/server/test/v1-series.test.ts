import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, schema } from '@haelan/core'
import { MAX_RANGE_DAYS } from '../src/routes/v1/shared.ts'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// The seed every test in this file builds on. Defaults match what a merged steps row looks like
// day to day; a test overrides only the field it cares about.
function seedDaily(h: Harness, input: {
  localDate: string
  value: number
  metric?: string
  agg?: string
  source?: string
  coverage?: number | null
  personId?: string
}): void {
  h.app.haelan.instance.db.insert(schema.daily).values({
    personId: input.personId ?? 'p1',
    localDate: input.localDate,
    metric: input.metric ?? 'steps',
    agg: input.agg ?? 'sum',
    source: input.source ?? 'merged',
    value: input.value,
    coverage: input.coverage === undefined ? null : input.coverage,
    sourceMix: null,
    derivationVersion: DERIVATION_VERSION,
  }).run()
}

async function get(h: Harness, token: string, path: string) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/p/p1${path}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('GET /series', () => {
  // series takes a repeated metric so the Dashboard is one request rather than ten.
  it('answers several metrics in one call, keyed by metric', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', metric: 'steps', value: 900 })
    seedDaily(harness, { localDate: '2026-08-01', metric: 'floors', value: 12 })

    const response = await get(harness, token, '/series?metric=steps&metric=floors&agg=sum&from=2026-08-01&to=2026-08-01')
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.steps.points[0].value).toBe(900)
    expect(body.floors.points[0].value).toBe(12)
  })

  // PersonQuery throws rather than returning an emptiness, deliberately: an empty result is
  // indistinguishable from "this person has no data", which in M4 becomes an agent stating a
  // false thing about a health record.
  it('answers 400 with the real reason for a metric that does not exist', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/series?metric=hart_rate&agg=mean&from=2026-08-01&to=2026-08-02')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('hart_rate')
  })

  it('answers 400 for a range whose end precedes its start', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/series?metric=steps&agg=sum&from=2026-08-31&to=2026-08-01')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  // The envelope is the point: a client handed 200 points where 365 existed, with no way to know,
  // cannot state the basis of what it drew. Ruling R2: the body is keyed by metric even for one
  // metric, so this reads body.steps.reduction and body.steps.points rather than the top level.
  it('reports the reduction when points thinned the series, and null when it did not', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 28; day += 1) {
      seedDaily(harness, { localDate: `2026-08-${String(day).padStart(2, '0')}`, value: day * 100 })
    }
    const thinned = await get(harness, token, '/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-28&points=10')
    expect(thinned.json().steps.reduction).toMatchObject({ from: 28 })
    expect(thinned.json().steps.points.length).toBeLessThanOrEqual(10)

    const whole = await get(harness, token, '/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-28')
    expect(whole.json().steps.reduction).toBeNull()
  })

  it('carries coverage and the source mix through, since a headline number states its basis', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900, coverage: 0.42 })
    const point = (await get(harness, token, '/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')).json().steps.points[0]
    expect(point.coverage).toBe(0.42)
    expect(point).toHaveProperty('sourceMix')
  })

  it('answers 400 when no metric is given, rather than an empty keyed object', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/series?agg=sum&from=2026-08-01&to=2026-08-01')
    expect(response.statusCode).toBe(400)
  })
})

describe('GET /baselines', () => {
  it("answers the person's own baseline for a metric as of a date", async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 5; day += 1) {
      seedDaily(harness, { localDate: `2026-08-0${day}`, value: 10 })
    }
    const response = await get(harness, token, '/baselines?metric=steps&agg=sum&on=2026-08-06&windowDays=5')
    expect(response.statusCode).toBe(200)
    expect(response.json().baseline.center).toBeCloseTo(10, 10)
    expect(response.json().baseline.n).toBe(5)
  })

  // Answering null with no history is right; answering it as a bare top level null was a second
  // top level shape for one route, which every client would have to branch on. The key is always
  // present, and only its value moves.
  it('answers a null baseline when there is no history at all, still under the same key', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/baselines?metric=steps&agg=sum&on=2026-08-06')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ baseline: null })
  })

  it('answers 400 for a metric the catalogue does not declare', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/baselines?metric=hart_rate&agg=mean&on=2026-08-06')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('hart_rate')
  })
})

describe('GET /insights', () => {
  it('compares a period against the one before it', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 7; day += 1) {
      seedDaily(harness, { localDate: `2026-08-0${day}`, value: 80, coverage: 0.9 })
    }
    for (let day = 8; day <= 14; day += 1) {
      seedDaily(harness, { localDate: `2026-08-${day}`, value: 100, coverage: 0.9 })
    }
    const response = await get(harness, token, '/insights?metric=steps&agg=sum&from=2026-08-08&to=2026-08-14')
    expect(response.statusCode).toBe(200)
    expect(response.json().current).toBeCloseTo(100, 10)
    expect(response.json().previous).toBeCloseTo(80, 10)
    expect(response.json().suppressed).toBe(false)
  })

  it('answers 400 for a reversed range', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/insights?metric=steps&agg=sum&from=2026-08-14&to=2026-08-08')
    expect(response.statusCode).toBe(400)
  })
})

describe('GET /trend', () => {
  it("smooths the person's own series", async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 10; day += 1) {
      seedDaily(harness, { localDate: `2026-08-${String(day).padStart(2, '0')}`, value: 80 })
    }
    const response = await get(harness, token, '/trend?metric=steps&agg=sum&from=2026-08-01&to=2026-08-10')
    expect(response.statusCode).toBe(200)
    // Under a key, not a bare top level array: a client reads body.points here the same way it
    // reads body[metric].points on /series, rather than branching on the body being an array.
    const { points } = response.json()
    expect(Array.isArray(points)).toBe(true)
    expect(points.every((p: { value: number }) => p.value === 80)).toBe(true)
  })

  it('answers 400 for an unknown metric', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/trend?metric=hart_rate&agg=mean&from=2026-08-01&to=2026-08-10')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('hart_rate')
  })

  // trend builds one entry per day in the range whether or not any data exists, so the range
  // itself is the cost. Unbounded, this was one authenticated GET with no body that held the
  // event loop for about twelve seconds against an empty database. The message has to name the
  // limit, so a caller learns what to ask for instead of guessing.
  it('answers 400 rather than materialising a range wider than the maximum', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/trend?metric=steps&agg=sum&from=1900-01-01&to=2100-01-01')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain(String(MAX_RANGE_DAYS))
  })

  // The ceiling is meant to be generous, not to get in the way: a decade wide "all time" view is
  // still an ordinary request and has to answer normally.
  it('still answers a range exactly at the maximum', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const from = '2020-01-01'
    const to = new Date(Date.parse(`${from}T00:00:00Z`) + (MAX_RANGE_DAYS - 1) * 86_400_000)
      .toISOString().slice(0, 10)
    const response = await get(harness, token, `/trend?metric=steps&agg=sum&from=${from}&to=${to}`)
    expect(response.statusCode).toBe(200)
  })
})
