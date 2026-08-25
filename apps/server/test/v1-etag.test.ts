import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'
import { stampEtag, hashEtag, notModified } from '../src/api/etag.ts'

// A deletion moves the count without moving any timestamp. An ETag on the timestamp alone would
// let a client keep a row the derivation has dropped.
it('changes when a row goes away even though no timestamp moved', () => {
  expect(stampEtag(1000, 10)).not.toBe(stampEtag(1000, 9))
})

it('is stable for the same stamp and count', () => {
  expect(stampEtag(1000, 10)).toBe(stampEtag(1000, 10))
})

it('handles a response with no stamped rows at all', () => {
  expect(typeof stampEtag(null, 0)).toBe('string')
})

it('hashes a body to something stable and order sensitive', () => {
  expect(hashEtag({ a: 1 })).toBe(hashEtag({ a: 1 }))
  expect(hashEtag([1, 2])).not.toBe(hashEtag([2, 1]))
})

it('matches a weak validator, since both bases emit weak ones', () => {
  const etag = stampEtag(1000, 10)
  expect(notModified({ headers: { 'if-none-match': etag } } as never, etag)).toBe(true)
  expect(notModified({ headers: { 'if-none-match': stampEtag(1000, 9) } } as never, etag)).toBe(false)
})

it('handles a list of validators and a star', () => {
  const etag = stampEtag(1000, 10)
  expect(notModified({ headers: { 'if-none-match': `W/"other", ${etag}` } } as never, etag)).toBe(true)
  expect(notModified({ headers: { 'if-none-match': '*' } } as never, etag)).toBe(true)
  expect(notModified({ headers: {} } as never, etag)).toBe(false)
})

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

function seedDaily(h: Harness, input: {
  localDate: string
  value: number
  metric?: string
  agg?: string
  source?: string
  coverage?: number | null
  personId?: string
  updatedAtMs?: number | null
}): void {
  const row = {
    personId: input.personId ?? 'p1',
    localDate: input.localDate,
    metric: input.metric ?? 'steps',
    agg: input.agg ?? 'sum',
    source: input.source ?? 'merged',
    value: input.value,
    coverage: input.coverage === undefined ? null : input.coverage,
    sourceMix: null,
    derivationVersion: DERIVATION_VERSION,
    updatedAtMs: input.updatedAtMs === undefined ? null : input.updatedAtMs,
  }
  // onConflictDoUpdate rather than a plain insert, so a test can rewrite an already seeded day
  // the way a real rebuild does, in place, over the same natural key.
  h.app.haelan.instance.db.insert(schema.daily).values(row).onConflictDoUpdate({
    target: [schema.daily.personId, schema.daily.localDate, schema.daily.metric, schema.daily.agg, schema.daily.source],
    set: row,
  }).run()
}

function seedSource(h: Harness, sourceId: string): void {
  h.app.haelan.instance.db.insert(schema.sources).values({
    id: sourceId, personId: 'p1', externalId: sourceId, displayName: sourceId,
    kind: 'device', createdAtMs: 0,
  }).onConflictDoNothing().run()
}

async function get(h: Harness, token: string, path: string, ifNoneMatch?: string) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/p/p1${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(ifNoneMatch === undefined ? {} : { 'if-none-match': ifNoneMatch }),
    },
  })
}

describe('conditional requests on the daily backed routes', () => {
  it('answers /series with an ETag, then 304 with no body once the client already has it', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900, updatedAtMs: 1_770_000_000_000 })

    const first = await get(harness, token, '/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    expect(first.statusCode).toBe(200)
    const etag = first.headers.etag
    expect(typeof etag).toBe('string')

    const second = await get(
      harness, token, '/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-01', etag as string,
    )
    expect(second.statusCode).toBe(304)
    expect(second.headers.etag).toBe(etag)
    // Fastify's own answer to a bare reply.code(304).send(): no body and no content-length,
    // rather than a Content-Length: 0 that would still be describing a body that is not there.
    expect(second.body).toBe('')
    expect(second.headers['content-length']).toBeUndefined()
  })

  it('changes the /series ETag once the underlying row changes', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900, updatedAtMs: 1_770_000_000_000 })
    const before = await get(harness, token, '/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')

    seedDaily(harness, { localDate: '2026-08-02', value: 500, updatedAtMs: 1_770_000_001_000 })
    const after = await get(harness, token, '/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-02')

    expect(after.headers.etag).not.toBe(before.headers.etag)
  })

  // Ruling R2: /series answers keyed by metric even for one. The ETag has to account for every
  // metric in the response, not just the first one folded in.
  it('folds every metric of a multi metric /series into one ETag', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', metric: 'steps', value: 900, updatedAtMs: 1000 })
    seedDaily(harness, { localDate: '2026-08-01', metric: 'floors', value: 12, updatedAtMs: 2000 })

    const both = await get(harness, token, '/series?metric=steps&metric=floors&agg=sum&from=2026-08-01&to=2026-08-01')
    const stepsOnly = await get(harness, token, '/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    // Adding floors' newer stamp and its row must move the ETag away from the steps only answer.
    expect(both.headers.etag).not.toBe(stepsOnly.headers.etag)

    const repeat = await get(harness, token, '/series?metric=steps&metric=floors&agg=sum&from=2026-08-01&to=2026-08-01')
    expect(repeat.headers.etag).toBe(both.headers.etag)
  })

  it('answers a stable ETag for a null /baselines, so a client with no history is not always miss', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const first = await get(harness, token, '/baselines?metric=steps&agg=sum&on=2026-08-06')
    expect(first.json()).toBeNull()
    const second = await get(harness, token, '/baselines?metric=steps&agg=sum&on=2026-08-06')
    expect(second.headers.etag).toBe(first.headers.etag)

    const cached = await get(
      harness, token, '/baselines?metric=steps&agg=sum&on=2026-08-06', first.headers.etag as string,
    )
    expect(cached.statusCode).toBe(304)
    expect(cached.body).toBe('')
  })

  it('changes the /baselines ETag once a day inside the window is written', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 5; day += 1) {
      seedDaily(harness, { localDate: `2026-08-0${day}`, value: 10, updatedAtMs: 1000 })
    }
    const before = await get(harness, token, '/baselines?metric=steps&agg=sum&on=2026-08-06&windowDays=5')
    seedDaily(harness, { localDate: '2026-08-03', value: 20, updatedAtMs: 5000 })
    const after = await get(harness, token, '/baselines?metric=steps&agg=sum&on=2026-08-06&windowDays=5')
    expect(after.headers.etag).not.toBe(before.headers.etag)
  })

  it('answers /trend and /insights with an ETag honoured by If-None-Match', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 10; day += 1) {
      seedDaily(harness, { localDate: `2026-08-${String(day).padStart(2, '0')}`, value: 80, updatedAtMs: 1000 })
    }
    const trend = await get(harness, token, '/trend?metric=steps&agg=sum&from=2026-08-01&to=2026-08-10')
    expect(trend.statusCode).toBe(200)
    const trendCached = await get(
      harness, token, '/trend?metric=steps&agg=sum&from=2026-08-01&to=2026-08-10', trend.headers.etag as string,
    )
    expect(trendCached.statusCode).toBe(304)
    expect(trendCached.body).toBe('')

    for (let day = 1; day <= 7; day += 1) {
      seedDaily(harness, { localDate: `2026-08-${String(day).padStart(2, '0')}`, value: 80, updatedAtMs: 2000, metric: 'floors' })
    }
    const insights = await get(harness, token, '/insights?metric=floors&agg=sum&from=2026-08-08&to=2026-08-14')
    expect(insights.statusCode).toBe(200)
    const insightsCached = await get(
      harness, token, '/insights?metric=floors&agg=sum&from=2026-08-08&to=2026-08-14', insights.headers.etag as string,
    )
    expect(insightsCached.statusCode).toBe(304)
    expect(insightsCached.body).toBe('')
  })
})

describe('conditional requests on the hash backed routes', () => {
  it('answers /intraday with an ETag, then 304 with no body once the client already has it', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSource(harness, 'watch')
    const utcMs = Date.UTC(2026, 7, 22, 9, 0) - 120 * 60_000
    harness.app.haelan.instance.db.insert(schema.samples).values({
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
      utcMs, tzOffsetMinutes: 120, agg: 'mean', value: 60, n: 1, rawPayloadId: null,
    }).run()

    const first = await get(harness, token, '/intraday?metric=heart_rate&date=2026-08-22')
    expect(first.statusCode).toBe(200)
    const etag = first.headers.etag
    expect(typeof etag).toBe('string')

    const second = await get(harness, token, '/intraday?metric=heart_rate&date=2026-08-22', etag as string)
    expect(second.statusCode).toBe(304)
    expect(second.headers.etag).toBe(etag)
    expect(second.body).toBe('')
  })

  it('changes the /intraday ETag once a second point is written, even though nothing carries a timestamp', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSource(harness, 'watch')
    const utcMs = Date.UTC(2026, 7, 22, 9, 0) - 120 * 60_000
    harness.app.haelan.instance.db.insert(schema.samples).values({
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
      utcMs, tzOffsetMinutes: 120, agg: 'mean', value: 60, n: 1, rawPayloadId: null,
    }).run()
    const before = await get(harness, token, '/intraday?metric=heart_rate&date=2026-08-22')

    harness.app.haelan.instance.db.insert(schema.samples).values({
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
      utcMs: utcMs + 60_000, tzOffsetMinutes: 120, agg: 'mean', value: 61, n: 1, rawPayloadId: null,
    }).run()
    const after = await get(harness, token, '/intraday?metric=heart_rate&date=2026-08-22')
    expect(after.headers.etag).not.toBe(before.headers.etag)
  })
})
