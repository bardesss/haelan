import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readIntraday } from '../src/query/intraday.ts'
import { samples, sources } from '../src/db/schema/index.ts'
import type { SampleAgg } from '../src/db/schema/index.ts'

const OFFSET = 120
const LOCAL_DATE = '2026-08-22'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  for (const id of ['watch', 'phone']) {
    test.db.insert(sources).values({
      id, personId: 'p1', externalId: id, displayName: id, kind: 'device', createdAtMs: 0,
    }).run()
  }
})
afterEach(() => test.cleanup())

const insert = (o: {
  utcMs: number, agg: SampleAgg, value: number, tzOffsetMinutes?: number, sourceId?: string,
}) =>
  test.db.insert(samples).values({
    personId: 'p1', sourceId: o.sourceId ?? 'watch', metric: 'heart_rate', utcMs: o.utcMs,
    tzOffsetMinutes: o.tzOffsetMinutes ?? OFFSET, agg: o.agg, value: o.value, n: 1,
    rawPayloadId: null,
  }).run()

// 09:00 local on 2026-08-22 at +120 is 07:00Z.
const NINE_AM = Date.UTC(2026, 7, 22, 7, 0)

describe('readIntraday', () => {
  it("puts a minute's min, mean and max on one row", () => {
    insert({ utcMs: NINE_AM, agg: 'min', value: 58 })
    insert({ utcMs: NINE_AM, agg: 'mean', value: 62 })
    insert({ utcMs: NINE_AM, agg: 'max', value: 71 })

    const out = readIntraday(test.db, { personId: 'p1', metric: 'heart_rate', localDate: LOCAL_DATE })
    expect(out.points).toHaveLength(1)
    expect(out.points[0]).toMatchObject({ utcMs: NINE_AM, min: 58, mean: 62, max: 71 })
  })

  it('excludes a reading that belongs to the next local day', () => {
    insert({ utcMs: NINE_AM, agg: 'mean', value: 62 })
    // 00:30 local on the 23rd, which is 22:30Z on the 22nd: a UTC day filter would wrongly keep it.
    insert({ utcMs: Date.UTC(2026, 7, 22, 22, 30), agg: 'mean', value: 99 })

    const out = readIntraday(test.db, { personId: 'p1', metric: 'heart_rate', localDate: LOCAL_DATE })
    expect(out.points.map((p) => p.mean)).toEqual([62])
  })

  // Every other test in this package uses a whole hour offset, at which the local and the UTC hour
  // partitions are identical, so none of them can tell local bucketing from UTC bucketing. At +345
  // they differ, which is the whole point of this case. The M2 audit named this gap.
  it("uses the row's own offset, so a 45 minute offset still lands on the right local day", () => {
    // 23:50 local in Kathmandu (+345) on 2026-08-22 is 18:05Z the same day.
    insert({ utcMs: Date.UTC(2026, 7, 22, 18, 5), agg: 'mean', value: 55, tzOffsetMinutes: 345 })
    // 00:10 local on the 23rd is 18:25Z on the 22nd: same UTC day, different local day.
    insert({ utcMs: Date.UTC(2026, 7, 22, 18, 25), agg: 'mean', value: 99, tzOffsetMinutes: 345 })

    const out = readIntraday(test.db, { personId: 'p1', metric: 'heart_rate', localDate: LOCAL_DATE })
    expect(out.points.map((p) => p.mean)).toEqual([55])
  })

  it('thins to the requested point count and says what it did', () => {
    for (let minute = 0; minute < 600; minute += 1) {
      insert({ utcMs: NINE_AM + minute * 60_000, agg: 'mean', value: 60 + (minute % 7) })
    }
    const out = readIntraday(test.db, {
      personId: 'p1', metric: 'heart_rate', localDate: LOCAL_DATE, points: 100,
    })
    expect(out.points.length).toBeLessThanOrEqual(100)
    expect(out.reduction).toMatchObject({ method: 'minmax', from: 600 })
  })

  it('returns nothing rather than throwing for a day with no samples', () => {
    const out = readIntraday(test.db, { personId: 'p1', metric: 'heart_rate', localDate: LOCAL_DATE })
    expect(out.points).toEqual([])
    expect(out.reduction).toBeNull()
  })

  // Two devices can report the same metric at the same minute. Pivoting on utcMs alone would let
  // whichever row the query happened to return last win each of min, mean and max independently,
  // which is not a reading of anything. Source selection belongs to the derive layer's priority
  // list, not to a second heuristic living in a reader.
  it('keeps two sources at the same minute as two points, not one blended point', () => {
    insert({ utcMs: NINE_AM, agg: 'mean', value: 62, sourceId: 'watch' })
    insert({ utcMs: NINE_AM, agg: 'mean', value: 90, sourceId: 'phone' })

    const out = readIntraday(test.db, { personId: 'p1', metric: 'heart_rate', localDate: LOCAL_DATE })
    // Direct order, not sorted before comparing: 'phone' sorts before 'watch' at the same utcMs.
    expect(out.points.map((p) => ({ sourceId: p.sourceId, mean: p.mean })))
      .toEqual([{ sourceId: 'phone', mean: 90 }, { sourceId: 'watch', mean: 62 }])
  })

  it('filters to the requested source rather than every device reporting that minute', () => {
    insert({ utcMs: NINE_AM, agg: 'mean', value: 62, sourceId: 'watch' })
    insert({ utcMs: NINE_AM, agg: 'mean', value: 90, sourceId: 'phone' })

    const out = readIntraday(test.db, {
      personId: 'p1', metric: 'heart_rate', localDate: LOCAL_DATE, sourceId: 'watch',
    })
    expect(out.points).toEqual([expect.objectContaining({ sourceId: 'watch', mean: 62 })])
  })

  // A subtler version of the same defect: pivoting per source is not enough if thinning still
  // hands one interleaved array covering every source to a single thin() call. minmax buckets by
  // index and picks extremes by value with no notion of source, so once the combined series is
  // large enough to trigger thinning, a bucket spanning both devices can take one device's low
  // point and another device's high point into what was one span of time. Watch is flat so it
  // never wins an extreme on its own; phone swings far below and far above watch's whole range so
  // it wins every combined bucket's min and max, and would starve watch's output down to whatever
  // survives by accident of where a sort happens to place a series boundary.
  it('thins each source on its own share of the budget, never mixing a bucket across sources', () => {
    for (let minute = 0; minute < 300; minute += 1) {
      insert({ utcMs: NINE_AM + minute * 60_000, agg: 'mean', value: 60, sourceId: 'watch' })
      insert({
        utcMs: NINE_AM + minute * 60_000, agg: 'mean', value: minute % 2 === 0 ? 0 : 1000,
        sourceId: 'phone',
      })
    }

    const out = readIntraday(test.db, {
      personId: 'p1', metric: 'heart_rate', localDate: LOCAL_DATE, points: 100,
    })

    const watchPoints = out.points.filter((p) => p.sourceId === 'watch')
    const phonePoints = out.points.filter((p) => p.sourceId === 'phone')

    expect(out.points.length).toBeLessThanOrEqual(100)
    // No point's own fields are ever corrupted by the bug, so this alone would pass either way;
    // it is here to rule out mislabeling before the count check below rules out starvation.
    expect(watchPoints.every((p) => p.mean === 60)).toBe(true)
    expect(phonePoints.every((p) => p.mean === 0 || p.mean === 1000)).toBe(true)
    // Thinned on its own budget, watch keeps a real share rather than being reduced to whichever
    // one or two points a shared, value-driven bucketing happened to leave it.
    expect(watchPoints.length).toBeGreaterThanOrEqual(20)
    expect(phonePoints.length).toBeGreaterThanOrEqual(20)
  })

  // thin always keeps at least the first and last point of a series it thins at all, so a budget
  // below 2 per source cannot be honoured exactly without dropping a source to nothing. The floor
  // wins deliberately: the total comes back over the requested count rather than under-reporting
  // a device into invisibility. reduction is what makes that honest rather than a lie of omission.
  it('lets the per-source floor exceed a budget too small to split evenly, and says so in reduction', () => {
    for (let minute = 0; minute < 5; minute += 1) {
      insert({ utcMs: NINE_AM + minute * 60_000, agg: 'mean', value: 60 + minute, sourceId: 'watch' })
      insert({ utcMs: NINE_AM + minute * 60_000, agg: 'mean', value: 80 + minute, sourceId: 'phone' })
    }

    const out = readIntraday(test.db, {
      personId: 'p1', metric: 'heart_rate', localDate: LOCAL_DATE, points: 2,
    })

    // 2 sources sharing a budget of 2 floors to 2 points each, not 1: 4 total, over the request.
    expect(out.points).toHaveLength(4)
    expect(out.points.filter((p) => p.sourceId === 'watch')).toHaveLength(2)
    expect(out.points.filter((p) => p.sourceId === 'phone')).toHaveLength(2)
    // 10 in, 4 out: reduction reports what actually came back, not the budget that was asked for.
    expect(out.reduction).toEqual({ method: 'minmax', from: 10, to: 4 })
  })
})
