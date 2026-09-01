import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'
import { stampEtag, hashEtag, notModified, SERIALIZATION_VERSION } from '../src/api/etag.ts'

// stampEtag takes one pair per window an answer drew on. Most of the assertions below are about
// a single window, so they say so once here rather than building the array eight times.
const oneWindow = (newestMs: number | null, rows: number) => stampEtag([{ newestMs, rows }])

// A deletion moves the count without moving any timestamp. An ETag on the timestamp alone would
// let a client keep a row the derivation has dropped.
it('changes when a row goes away even though no timestamp moved', () => {
  expect(oneWindow(1000, 10)).not.toBe(oneWindow(1000, 9))
})

it('is stable for the same stamp and count', () => {
  expect(oneWindow(1000, 10)).toBe(oneWindow(1000, 10))
})

it('handles a response with no stamped rows at all', () => {
  expect(typeof oneWindow(null, 0)).toBe('string')
})

// The windows used to be folded into one pair, by taking the newest stamp and adding the counts.
// A row lost by one window and gained by another on an equal or older stamp then cancelled: same
// maximum, same total, same validator, over a body that had changed.
it('does not let one window\'s lost row cancel another window\'s gained one', () => {
  expect(stampEtag([{ newestMs: 1000, rows: 2 }, { newestMs: 1000, rows: 1 }]))
    .not.toBe(stampEtag([{ newestMs: 1000, rows: 1 }, { newestMs: 1000, rows: 2 }]))
})

// Every route that reads one window still emits the same stamp-and-count body it always did, only
// with the serialization version now prefixed onto it. The window-folding change above is not a
// second cache invalidation on top of the one below for /baselines and /trend clients as well.
it('renders a single window the way it always did, under today\'s serialization version', () => {
  expect(oneWindow(1000, 10)).toBe(`W/"v${SERIALIZATION_VERSION}.1000-10"`)
  expect(oneWindow(null, 0)).toBe(`W/"v${SERIALIZATION_VERSION}.none-0"`)
})

// The reason SERIALIZATION_VERSION exists at all: rounding at the response boundary changed what
// /series, /baselines, /insights and /trend send for the exact same rows under the exact same
// stamp and count, which newestMs and rows alone cannot see move. A validator computed the way
// this route rendered one before that change must fail to match today's, or a client holding it
// would revalidate, get a stamp-and-count match, and be told 304 to keep the old, unrounded body
// forever.
it('gives a pre-versioning validator no match against today\'s, so a stale unrounded body cannot survive behind it', () => {
  const preVersioning = 'W/"1000-10"' // what this exact window rendered before SERIALIZATION_VERSION existed
  const today = oneWindow(1000, 10)
  expect(today).not.toBe(preVersioning)
  expect(notModified({ headers: { 'if-none-match': preVersioning } } as never, today)).toBe(false)
})

it('hashes a body to something stable and order sensitive', () => {
  expect(hashEtag({ a: 1 })).toBe(hashEtag({ a: 1 }))
  expect(hashEtag([1, 2])).not.toBe(hashEtag([2, 1]))
})

it('matches a weak validator, since both bases emit weak ones', () => {
  const etag = oneWindow(1000, 10)
  expect(notModified({ headers: { 'if-none-match': etag } } as never, etag)).toBe(true)
  expect(notModified({ headers: { 'if-none-match': oneWindow(1000, 9) } } as never, etag)).toBe(false)
})

it('handles a list of validators and a star', () => {
  const etag = oneWindow(1000, 10)
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

// What a rebuild does when a day's rows no longer derive: it removes them. Raw SQL rather than a
// drizzle delete, because drizzle-orm is core's dependency and this package does not declare it;
// the same $client the rest of this suite's sibling tests reach through.
function deleteDaily(h: Harness, input: { localDate: string, metric: string }): void {
  h.app.haelan.instance.db.$client
    .prepare('delete from daily where person_id = ? and local_date = ? and metric = ?')
    .run('p1', input.localDate, input.metric)
}

function seedSource(h: Harness, sourceId: string): void {
  h.app.haelan.instance.db.insert(schema.sources).values({
    id: sourceId, personId: 'p1', externalId: sourceId, displayName: sourceId,
    kind: 'device', createdAtMs: 0,
  }).onConflictDoNothing().run()
}

// August in Europe/Amsterdam, the offset every harness person carries, matching the constant
// v1-tier2.test.ts established.
const OFFSET_MINUTES = 120

// One session, of either kind, for the two routes whose ETag is a hash of the assembled body.
// `sessions` carries no updated_at_ms at all, which is the whole reason those two routes hash
// instead of stamping, so a test that moves their data has to move the body rather than a column.
function seedSession(h: Harness, input: {
  id: string
  kind: 'sleep' | 'exercise'
  localDate: string
  sourceId?: string
}): void {
  const sourceId = input.sourceId ?? 'watch'
  seedSource(h, sourceId)
  const startMs = Date.parse(`${input.localDate}T21:00:00Z`) - OFFSET_MINUTES * 60_000
  const row = {
    id: input.id, personId: 'p1', sourceId, kind: input.kind, externalId: input.id,
    startMs, startOffsetMinutes: OFFSET_MINUTES, endMs: startMs + 3_600_000,
    endOffsetMinutes: OFFSET_MINUTES, localDate: input.localDate,
    attrs: JSON.stringify({ mainSleep: input.kind === 'sleep' }), rawPayloadId: null,
  }
  h.app.haelan.instance.db.insert(schema.sessions).values(row)
    .onConflictDoUpdate({ target: schema.sessions.id, set: row }).run()
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

  // The URL is held fixed and only the data moves. Widening the range between the two requests
  // as well, which this test used to do, means an implementation stamping nothing but the row
  // count also passes it: the second request covered a day more and so counted a row more. What
  // the name claims is that a row changing in place moves the validator, and only a rewritten
  // row over an unchanged range asserts that.
  it('changes the /series ETag once the underlying row changes', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const url = '/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-01'
    seedDaily(harness, { localDate: '2026-08-01', value: 900, updatedAtMs: 1_770_000_000_000 })
    const before = await get(harness, token, url)
    expect(before.json().steps.points).toHaveLength(1)

    // Rewritten in place over the same natural key, which is what a rebuild does to a day it
    // re-derives: same row, new value, new stamp, and the count does not move.
    seedDaily(harness, { localDate: '2026-08-01', value: 1200, updatedAtMs: 1_770_000_001_000 })
    const after = await get(harness, token, url)
    expect(after.json().steps.points).toHaveLength(1)
    expect(after.json().steps.points[0].value).toBe(1200)

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

  // A repeated metric produces a body byte identical to the single metric one, so it has to
  // produce the same validator: counting the same rows twice stamped it W/"v1.1000-2" against the
  // other's W/"v1.1000-1", and a client comparing the two would refetch a body it already had.
  it('gives a repeated metric the same /series ETag as asking for it once', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', metric: 'steps', value: 900, updatedAtMs: 1000 })

    const once = await get(harness, token, '/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    const twice = await get(harness, token, '/series?metric=steps&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    expect(twice.body).toBe(once.body)
    expect(twice.headers.etag).toBe(once.headers.etag)
  })

  // combineStamps has to fold in every metric's stamp, not just carry the first one through: a
  // bug that only looked at metrics[0] would still pass the test above, since steps changes
  // there too. Holding the metric set fixed and moving only the second metric's data is what
  // catches that specifically.
  it('moves the /series ETag when only the second of two requested metrics changes', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', metric: 'steps', value: 900, updatedAtMs: 1000 })
    seedDaily(harness, { localDate: '2026-08-01', metric: 'floors', value: 12, updatedAtMs: 1000 })
    const before = await get(harness, token, '/series?metric=steps&metric=floors&agg=sum&from=2026-08-01&to=2026-08-01')

    seedDaily(harness, { localDate: '2026-08-01', metric: 'floors', value: 12, updatedAtMs: 9000 })
    const after = await get(harness, token, '/series?metric=steps&metric=floors&agg=sum&from=2026-08-01&to=2026-08-01')

    expect(after.headers.etag).not.toBe(before.headers.etag)
  })

  // The counts used to be summed across metrics into one figure. Within a single URL that let a
  // row lost by one metric and gained by another on an equal stamp cancel: the maximum stamp did
  // not move, the total did not move, and a client comparing validators kept a body that had
  // changed. Contrived, and it costs nothing to make impossible.
  it('moves the /series ETag when one metric loses a row and another gains one on the same stamp', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', metric: 'steps', value: 900, updatedAtMs: 1000 })
    seedDaily(harness, { localDate: '2026-08-02', metric: 'steps', value: 950, updatedAtMs: 1000 })
    seedDaily(harness, { localDate: '2026-08-01', metric: 'floors', value: 12, updatedAtMs: 1000 })

    const url = '/series?metric=steps&metric=floors&agg=sum&from=2026-08-01&to=2026-08-02'
    const before = await get(harness, token, url)
    expect(before.json().steps.points).toHaveLength(2)
    expect(before.json().floors.points).toHaveLength(1)

    // Two rows into one metric and one into the other, then one into each: the same three rows
    // under the same newest stamp, and a different answer.
    deleteDaily(harness, { localDate: '2026-08-02', metric: 'steps' })
    seedDaily(harness, { localDate: '2026-08-02', metric: 'floors', value: 14, updatedAtMs: 1000 })

    const after = await get(harness, token, url)
    expect(after.json().steps.points).toHaveLength(1)
    expect(after.json().floors.points).toHaveLength(2)
    expect(after.body).not.toBe(before.body)
    expect(after.headers.etag).not.toBe(before.headers.etag)
  })

  // Batch derivation stamps every row it touches with one shared clock, so after a rebuild a
  // whole history can carry the same updated_at_ms. Thinning to points=2 always keeps exactly
  // the first and last row (downsample.ts's lttb: target <= 2 returns [first, last]) regardless
  // of what changed in between, so a stamp taken from the thinned body would pin both the row
  // count and, once every row shares a stamp, the max too, and miss a change to any of the 18
  // rows thinning did not surface.
  it('moves the /series ETag when a row outside a thinned page changes', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 20; day += 1) {
      seedDaily(harness, { localDate: `2026-08-${String(day).padStart(2, '0')}`, value: day, updatedAtMs: 1000 })
    }
    const range = '/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-20&points=2'
    const before = await get(harness, token, range)
    expect(before.json().steps.points.map((p: { localDate: string }) => p.localDate)).toEqual(['2026-08-01', '2026-08-20'])

    // Day 10 is neither endpoint, so points=2 keeps showing exactly the same two rows.
    seedDaily(harness, { localDate: '2026-08-10', value: 999, updatedAtMs: 5000 })
    const after = await get(harness, token, range)
    expect(after.json().steps.points.map((p: { localDate: string }) => p.localDate)).toEqual(['2026-08-01', '2026-08-20'])
    expect(after.headers.etag).not.toBe(before.headers.etag)
  })

  it('answers a stable ETag for a null /baselines, so a client with no history is not always miss', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const first = await get(harness, token, '/baselines?metric=steps&agg=sum&on=2026-08-06')
    expect(first.json()).toEqual({ baseline: null })
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

  // /intraday was the only one of the three hash backed tier 2 routes with coverage here, and it
  // is the one whose body shape differs from the other two: it answers { points, reduction },
  // while these two answer a { items, cursor } page out of paginate. sendHashed is called on the
  // assembled page, after slicing, so these two are where that ordering actually matters.
  const PAGED: readonly { name: string, url: string, kind: 'sleep' | 'exercise' }[] = [
    { name: '/sleep/nights', url: '/sleep/nights?from=2026-08-01&to=2026-08-07', kind: 'sleep' },
    { name: '/sessions', url: '/sessions?kind=exercise&from=2026-08-01&to=2026-08-07', kind: 'exercise' },
  ]

  describe.each(PAGED)('$name', (route) => {
    it('answers an ETag, then 304 with no body once the client already has it', async () => {
      harness = await withServer(); const token = await harness.signIn()
      seedSession(harness, { id: 'one', kind: route.kind, localDate: '2026-08-01' })

      const first = await get(harness, token, route.url)
      expect(first.statusCode).toBe(200)
      const etag = first.headers.etag
      expect(typeof etag).toBe('string')

      const second = await get(harness, token, route.url, etag as string)
      expect(second.statusCode).toBe(304)
      expect(second.headers.etag).toBe(etag)
      expect(second.body).toBe('')
      expect(second.headers['content-length']).toBeUndefined()
    })

    it('moves the ETag once the underlying data changes, though no row carries a timestamp', async () => {
      harness = await withServer(); const token = await harness.signIn()
      seedSession(harness, { id: 'one', kind: route.kind, localDate: '2026-08-01' })
      const before = await get(harness, token, route.url)
      expect(before.json().items).toHaveLength(1)

      seedSession(harness, { id: 'two', kind: route.kind, localDate: '2026-08-02' })
      const after = await get(harness, token, route.url)
      expect(after.json().items).toHaveLength(2)
      expect(after.headers.etag).not.toBe(before.headers.etag)

      // And the client that held the first validator is told so, rather than handed a 304 over a
      // body it no longer has.
      const stale = await get(harness, token, route.url, before.headers.etag as string)
      expect(stale.statusCode).toBe(200)
    })
  })
})

// Task 6 built the ETags before Tasks 7 and 8 added these two routes, so both shipped without
// one. /changes is the worst place for the gap: it exists to be polled, so a missing ETag means
// a client re-downloads the same body on every interval forever.
describe('conditional requests on /changes and /export', () => {
  it('answers /changes with an ETag, then 304 with no body once the client already has it', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900, updatedAtMs: 1_000 })

    const first = await get(harness, token, '/changes?since=0')
    expect(first.statusCode).toBe(200)
    const etag = first.headers.etag
    expect(typeof etag).toBe('string')

    const second = await get(harness, token, '/changes?since=0', etag as string)
    expect(second.statusCode).toBe(304)
    expect(second.body).toBe('')
  })

  // The polling client's usual answer is the empty page. It still has to be an ETag a later,
  // non-empty page cannot share, or the client stops seeing changes it asked for.
  it('changes the /changes ETag once another day moves', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900, updatedAtMs: 1_000 })
    const before = await get(harness, token, '/changes?since=0')

    seedDaily(harness, { localDate: '2026-08-02', value: 950, updatedAtMs: 2_000 })
    const after = await get(harness, token, '/changes?since=0')
    expect(after.headers.etag).not.toBe(before.headers.etag)
  })

  it('answers /export with an ETag in both formats, honoured by If-None-Match', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900 })

    for (const format of ['json', 'csv']) {
      const path = `/export?format=${format}&metric=steps&agg=sum&from=2026-08-01&to=2026-08-02`
      const first = await get(harness, token, path)
      expect(first.statusCode).toBe(200)
      expect(typeof first.headers.etag).toBe('string')

      const second = await get(harness, token, path, first.headers.etag as string)
      expect(second.statusCode).toBe(304)
      expect(second.body).toBe('')
    }
  })

  // The pair /changes already has. /export shipped with the 304 case and the two-formats case but
  // not this one, so nothing said its validator tracks the data at all: a hash over a body that
  // never changed would have passed both of the others.
  it('changes the /export ETag in both formats once the underlying row changes', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900 })

    for (const format of ['json', 'csv']) {
      const path = `/export?format=${format}&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01`
      const before = await get(harness, token, path)

      // A different value over the same natural key, so the range and the row count both hold
      // still and only what the file says changes. The hash base is what has to catch that;
      // /export hashes rather than stamps precisely because its body is a serialisation the row
      // stamps do not determine.
      seedDaily(harness, { localDate: '2026-08-01', value: 900 + (format === 'csv' ? 2 : 1) })
      const after = await get(harness, token, path)
      expect(after.headers.etag, format).not.toBe(before.headers.etag)

      const stale = await get(harness, token, path, before.headers.etag as string)
      expect(stale.statusCode, format).toBe(200)
    }
  })

  // The two formats are two different bodies over one route, so they must never share a
  // validator: a client that downloaded the csv and then asked for the json would otherwise be
  // told it already had it.
  it('gives the two /export formats different ETags for the same query', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900 })
    const range = 'metric=steps&agg=sum&from=2026-08-01&to=2026-08-02'
    const json = await get(harness, token, `/export?format=json&${range}`)
    const csv = await get(harness, token, `/export?format=csv&${range}`)
    expect(csv.headers.etag).not.toBe(json.headers.etag)
  })
})
