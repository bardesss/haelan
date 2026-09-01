import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, runDerive, schema } from '@haelan/core'
import { sampleTarget } from '@haelan/core/target-key'
import { hashEtag } from '../src/api/etag.ts'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// The seed every /series, /export, /trend and /insights test in this file builds on.
function seedDaily(h: Harness, input: {
  localDate: string
  value: number
  metric?: string
  agg?: string
  source?: string
  personId?: string
  coverage?: number | null
}): void {
  h.app.haelan.instance.db.insert(schema.daily).values({
    personId: input.personId ?? 'p1',
    localDate: input.localDate,
    metric: input.metric ?? 'heart_rate',
    agg: input.agg ?? 'mean',
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

// The exact figure the bug report started from: a heart_rate weighted mean with nothing upstream
// that ever rounds it. heart_rate's own catalogue precision is 0.
const UNROUNDED_MEAN = 90.18407633664866

describe('GET /series rounds to the catalogue precision', () => {
  it('rounds an unrounded weighted mean to heart_rate\'s own precision, 0 decimals', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: UNROUNDED_MEAN })

    const response = await get(harness, token, '/series?metric=heart_rate&agg=mean&from=2026-08-01&to=2026-08-01')
    expect(response.statusCode).toBe(200)
    expect(response.json().heart_rate.points[0].value).toBe(90)
  })

  // spo2's catalogue precision is 1, not 0, proving the response reads the precision per metric
  // from the catalogue rather than hardcoding heart_rate's own 0.
  it('rounds a different metric to its own, different precision', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', metric: 'spo2', agg: 'mean', value: 96.66666 })

    const response = await get(harness, token, '/series?metric=spo2&agg=mean&from=2026-08-01&to=2026-08-01')
    expect(response.json().spo2.points[0].value).toBe(96.7)
  })

  // Ruling R2 keys /series by metric even for one, and several metrics in one call each carry
  // their own precision: rounding must key off which metric a point belongs to, not one precision
  // applied to the whole response.
  it('rounds each metric in a multi metric response to its own precision', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', metric: 'heart_rate', agg: 'mean', value: 65.678 })
    seedDaily(harness, { localDate: '2026-08-01', metric: 'spo2', agg: 'mean', value: 96.678 })

    const response = await get(
      harness, token, '/series?metric=heart_rate&metric=spo2&agg=mean&from=2026-08-01&to=2026-08-01',
    )
    expect(response.json().heart_rate.points[0].value).toBe(66)
    expect(response.json().spo2.points[0].value).toBe(96.7)
  })
})

// The guarantee the whole design rests on, proven against the real derive path rather than
// against a `daily` row seeded by hand. seedDaily above writes straight into `daily` and never
// runs derive at all, so a test built only on it would stay green even if someone moved the
// rounding into rollup.ts's own `case 'mean'`: it would prove only that the response route does
// not write back to storage, which is a different (also real) guarantee, not this one.
describe('the derive path itself never rounds, only the response route does', () => {
  function seedRawSamples(h: Harness, localDate: string, metric: string, values: readonly number[]): void {
    h.app.haelan.instance.db.insert(schema.sources).values({
      id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
    }).onConflictDoNothing().run()
    // Distinct hours, same UTC local day (offset 0), so rollUpDay folds all three into one day's
    // weighted mean rather than three separate single-reading days.
    for (const [i, value] of values.entries()) {
      h.app.haelan.instance.db.insert(schema.samples).values({
        personId: 'p1', sourceId: 'watch', metric,
        utcMs: Date.parse(`${localDate}T0${i}:00:00Z`), tzOffsetMinutes: 0, agg: 'raw', value, n: 1, rawPayloadId: null,
      }).run()
    }
    h.app.haelan.instance.deriveQueue.markDirty({ personId: 'p1', localDate, nowMs: h.clock.nowMs })
  }

  function drainOnce(h: Harness): void {
    const instance = h.app.haelan.instance
    runDerive({
      db: instance.db, queue: instance.deriveQueue, priority: instance.sourcePriority,
      overrides: instance.overrides, settings: instance.settings, nowMs: h.clock.nowMs,
      personIds: ['p1'],
    })
  }

  it('keeps the daily row at full precision after a real derive, and only the response rounds it', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedRawSamples(harness, '2026-08-15', 'heart_rate', [60, 61, 63])
    drainOnce(harness)

    // rollUpDay's own weighted mean over these three raw readings (n=1 each): (60+61+63)/3, a
    // real repeating decimal, computed here the same way rollup.ts's case 'mean' computes it.
    const expectedMean = (60 + 61 + 63) / 3
    expect(Number.isInteger(expectedMean)).toBe(false)

    const row = harness.app.haelan.instance.db.$client
      .prepare("select value from daily where local_date = ? and metric = ? and agg = 'mean'")
      .get('2026-08-15', 'heart_rate') as { value: number } | undefined
    expect(row?.value).toBe(expectedMean)

    const response = await get(harness, token, '/series?metric=heart_rate&agg=mean&from=2026-08-15&to=2026-08-15')
    expect(response.json().heart_rate.points[0].value).toBe(Math.round(expectedMean))
  })
})

describe('GET /export rounds the same way /series does', () => {
  it('rounds the value column in the csv', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: UNROUNDED_MEAN })

    const response = await get(harness, token, '/export?format=csv&metric=heart_rate&agg=mean&from=2026-08-01&to=2026-08-01')
    const [, first] = response.body.trim().split('\n')
    expect(first).toBe('2026-08-01,heart_rate,mean,merged,90,,')
  })

  it('rounds the value field in the json export', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: UNROUNDED_MEAN })

    const response = await get(harness, token, '/export?format=json&metric=heart_rate&agg=mean&from=2026-08-01&to=2026-08-01')
    expect(response.json().heart_rate.points[0].value).toBe(90)
  })

  // The two formats must never disagree about the same day's figure.
  it('answers the same rounded value from csv and json for the same query', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: UNROUNDED_MEAN })

    const csv = await get(harness, token, '/export?format=csv&metric=heart_rate&agg=mean&from=2026-08-01&to=2026-08-01')
    const json = await get(harness, token, '/export?format=json&metric=heart_rate&agg=mean&from=2026-08-01&to=2026-08-01')
    const [, csvRow] = csv.body.trim().split('\n')
    expect(csvRow).toContain(',90,')
    expect(json.json().heart_rate.points[0].value).toBe(90)
  })

  // coverage is deliberately left raw in both formats (see export.ts's own comment on toCsv for
  // why: it has a real arithmetic property, value/24 recovering the exact observed-hours count,
  // that rounding destroys, and it feeds a real threshold comparison elsewhere in this codebase
  // that a rounded value could tip). 23 of 24 hours observed, coverageOf's own k/24 scale
  // (packages/core/src/derive/coverage.ts), is not a catalogue metric and gets no rounding at all
  // here, in either format, so csv and json cannot disagree about it the way they must not
  // disagree about `value` either.
  it('leaves coverage at full, un-rounded precision in both the csv and the json export', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', metric: 'steps', agg: 'sum', value: 900, coverage: 23 / 24 })

    const csv = await get(harness, token, '/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    const json = await get(harness, token, '/export?format=json&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    const [, first] = csv.body.trim().split('\n')
    expect(first).toBe('2026-08-01,steps,sum,merged,900,0.9583333333333334,')
    expect(json.json().steps.points[0].coverage).toBe(23 / 24)
  })
})

describe('GET /intraday rounds min, mean and max to the metric\'s own precision', () => {
  function seedSource(h: Harness, sourceId: string): void {
    h.app.haelan.instance.db.insert(schema.sources).values({
      id: sourceId, personId: 'p1', externalId: sourceId, displayName: sourceId,
      kind: 'device', createdAtMs: 0,
    }).onConflictDoNothing().run()
  }

  it('rounds a minute combined from several raw readings, not just a stored min/mean/max row', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSource(harness, 'watch')
    const utcMs = Date.UTC(2026, 7, 22, 9, 0) - 120 * 60_000
    // Three raw readings sharing a minute (different seconds, same minute bucket): readIntraday
    // combines them into the minute's own min, mean and max (60 + 61 + 63) / 3 =
    // 61.333333333333336, which heart_rate's precision-0 catalogue entry has no business handing
    // a reader with three decimals still attached.
    for (const [i, value] of [60, 61, 63].entries()) {
      harness.app.haelan.instance.db.insert(schema.samples).values({
        personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
        utcMs: utcMs + i * 1_000, tzOffsetMinutes: 120, agg: 'raw', value, n: 1, rawPayloadId: null,
      }).run()
    }

    const response = await get(harness, token, '/intraday?metric=heart_rate&date=2026-08-22')
    const [point] = response.json().points
    expect(point.mean).toBe(61)
    expect(point.min).toBe(60)
    expect(point.max).toBe(63)
  })
})

describe('GET /trend rounds its smoothed line to the metric\'s own precision', () => {
  it('rounds respiratory_rate\'s trend to 1 decimal', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 5; day += 1) {
      seedDaily(harness, {
        localDate: `2026-08-0${day}`, metric: 'respiratory_rate', agg: 'last', value: 14.666666666666666,
      })
    }
    const response = await get(
      harness, token, '/trend?metric=respiratory_rate&agg=last&from=2026-08-01&to=2026-08-05',
    )
    const { points } = response.json()
    for (const point of points) {
      const decimals = String(point.value).split('.')[1] ?? ''
      expect(decimals.length).toBeLessThanOrEqual(1)
    }
    // A flat input smooths to the same flat value: every point should round to exactly 14.7.
    expect(points.every((p: { value: number }) => p.value === 14.7)).toBe(true)
  })
})

describe('GET /insights rounds current, previous and delta to the metric\'s own precision', () => {
  it('rounds a heart_rate comparison to 0 decimals on all three fields', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 7; day += 1) {
      seedDaily(harness, { localDate: `2026-08-0${day}`, value: 60.666666666666664 })
    }
    for (let day = 8; day <= 14; day += 1) {
      seedDaily(harness, { localDate: `2026-08-${day}`, value: 70.333333333333333 })
    }
    const response = await get(harness, token, '/insights?metric=heart_rate&agg=mean&from=2026-08-08&to=2026-08-14')
    const body = response.json()
    expect(body.current).toBe(70)
    expect(body.previous).toBe(61)
    expect(body.delta).toBe(9)
    expect(Number.isInteger(body.current)).toBe(true)
    expect(Number.isInteger(body.previous)).toBe(true)
    expect(Number.isInteger(body.delta)).toBe(true)
  })
})

describe('GET /baselines leaves center and spread at full precision', () => {
  // Deliberate: Recovery.tsx and Sleep.tsx compute low = center - spread and high = center +
  // spread from these two raw fields before formatting either bound, so rounding them here would
  // change what those pages draw rather than just how many decimals a JSON viewer sees. steps has
  // catalogue precision 0; three days whose sum does not divide evenly proves this response is not
  // silently rounding to that precision the way every other route in this file now does.
  it('answers a mean with more decimals than the metric\'s own catalogue precision', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', metric: 'steps', agg: 'sum', value: 1 })
    seedDaily(harness, { localDate: '2026-08-02', metric: 'steps', agg: 'sum', value: 2 })
    seedDaily(harness, { localDate: '2026-08-03', metric: 'steps', agg: 'sum', value: 4 })

    const response = await get(harness, token, '/baselines?metric=steps&agg=sum&on=2026-08-04&windowDays=3')
    const { center } = response.json().baseline
    expect(center).toBeCloseTo(7 / 3, 10)
    // steps' catalogue precision is 0: a rounded center would be exactly 2, an integer. The real
    // mean is not.
    expect(Number.isInteger(center)).toBe(false)
  })
})

describe('GET /overrides rounds a correcting override\'s value to its own metric\'s precision', () => {
  // Only a sample scope override can carry a corrected value at all (OverrideStore.validate
  // refuses `correct` at any other scope), and its target key always names the metric, so this
  // route can round it the same way /series rounds the metric it targets.
  it('rounds a sample override\'s correctedValue using the metric its own target key names', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const targetKey = sampleTarget({ source: 'watch', metric: 'weight', utcMs: 1_755_000_000_000 })
    harness.app.haelan.instance.overrides.put({
      personId: 'p1', scope: 'sample', targetKey, action: 'correct',
      correctedValue: 14.666666666666666, reason: 'test fixture', nowMs: harness.clock.nowMs,
    })

    const response = await get(harness, token, '/overrides')
    // weight's catalogue precision is 1.
    expect(response.json().items[0].correctedValue).toBe(14.7)
  })

  it('leaves an excluding override with no corrected value untouched', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const targetKey = sampleTarget({ source: 'watch', metric: 'weight', utcMs: 1_755_000_000_000 })
    harness.app.haelan.instance.overrides.put({
      personId: 'p1', scope: 'sample', targetKey, action: 'exclude', reason: 'test fixture', nowMs: harness.clock.nowMs,
    })

    const response = await get(harness, token, '/overrides')
    expect(response.json().items[0].correctedValue).toBeNull()
  })

  // The one real path into roundMetricValue's unknown-metric branch, and the reason its own
  // comment in shared.ts can no longer call that branch unreachable. Unlike every other caller in
  // this codebase, this route's metric comes from parseSampleTarget on a stored target_key, never
  // from PersonQuery's own requireMetricAndAgg/requireMetric checks: OverrideStore.validate only
  // checks the target key's shape (sampleTarget builds a well formed one here, same as a real
  // POST /overrides body would), never that its metric names something METRICS actually declares.
  it('leaves a corrected value untouched when its own target key names a metric the catalogue does not declare', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const targetKey = sampleTarget({ source: 'watch', metric: 'made_up_metric', utcMs: 1_755_000_000_000 })
    harness.app.haelan.instance.overrides.put({
      personId: 'p1', scope: 'sample', targetKey, action: 'correct',
      correctedValue: 14.666666666666666, reason: 'test fixture', nowMs: harness.clock.nowMs,
    })

    const response = await get(harness, token, '/overrides')
    // Not rounded to any precision, and not thrown: an unknown metric passes its value through
    // exactly as it was written, per roundMetricValue's own contract.
    expect(response.json().items[0].correctedValue).toBe(14.666666666666666)
  })
})

// The concern named directly in the task: rounding at the response boundary must not let a
// conditional request serve a client the body it would have gotten before this change. This
// covers /export, /intraday and the other hash backed routes: sendHashed computes the ETag from
// the exact object it sends, so a validator computed against the old, unrounded body can never
// collide with the one the server now sends for the same data. The stamp backed routes
// (/series, /baselines, /insights, /trend) need a separate proof; see the describe block below.
describe('rounding cannot leave a stale, unrounded body behind a matching ETag (hash backed routes)', () => {
  it('answers a fresh 200 for an If-None-Match built from what the unrounded body used to hash to', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: UNROUNDED_MEAN })

    // What /export's ETag would have been before this task, over the same body but with the raw,
    // unrounded value still in it.
    const staleShapeEtag = hashEtag({
      heart_rate: {
        points: [{
          localDate: '2026-08-01', value: UNROUNDED_MEAN, coverage: null, source: 'merged',
          sourceMix: null, updatedAtMs: null,
        }],
        reduction: null,
      },
    })

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/p/p1/export?format=json&metric=heart_rate&agg=mean&from=2026-08-01&to=2026-08-01',
      headers: { authorization: `Bearer ${token}`, 'if-none-match': staleShapeEtag },
    })
    // Not a 304: a client holding that old validator does not already have today's rounded body.
    expect(response.statusCode).toBe(200)
    expect(response.json().heart_rate.points[0].value).toBe(90)
  })
})

// The gap a reviewer found in this task's first pass: /series, /baselines, /insights and /trend
// all answer through stampEtag, whose basis is `updated_at_ms` and row count, never content. Both
// figures are unmoved by this task's rounding, so a client holding an ETag computed by the
// pre-rounding server would revalidate, match on stamp and count alone, and be told 304 to keep
// the old, unrounded body forever, since nothing about the underlying row ever needs to move
// again for that client to notice. SERIALIZATION_VERSION (etag.ts) closes this by folding a fixed
// version term into every stamped ETag, so a validator rendered before this task's rounding
// shipped can never match one rendered after it.
describe('rounding cannot leave a stale, unrounded body behind a matching ETag (stamp backed routes)', () => {
  it('answers /series with 200, not 304, for an If-None-Match built the way this exact window rendered before rounding shipped', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: UNROUNDED_MEAN })

    // updatedAtMs defaults to null in seedDaily, and one row, so this window's stamp is
    // { newestMs: null, rows: 1 }. Before SERIALIZATION_VERSION existed, stampEtag rendered that
    // as exactly this string (see v1-etag.test.ts's own proof of the same fact on stampEtag
    // directly): no version term, just the stamp and the count.
    const preVersioningEtag = 'W/"none-1"'

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/p/p1/series?metric=heart_rate&agg=mean&from=2026-08-01&to=2026-08-01',
      headers: { authorization: `Bearer ${token}`, 'if-none-match': preVersioningEtag },
    })
    // Not a 304: the stamp and row count alone would have matched (nothing about the row moved),
    // which is exactly the bug this proves is closed. A client holding that pre-rounding
    // validator gets a fresh 200 with today's rounded body instead.
    expect(response.statusCode).toBe(200)
    expect(response.json().heart_rate.points[0].value).toBe(90)
  })
})
