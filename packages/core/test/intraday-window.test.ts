import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, insertSample } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readIntraday, readIntradayWindow } from '../src/query/intraday.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { ConfigError } from '../src/errors.ts'
import { sources } from '../src/db/schema/index.ts'

const OFFSET = 120
// 09:00 local on 2026-08-22 at +120 is 07:00Z.
const LOCAL_DATE = '2026-08-22'
const NINE_AM = Date.UTC(2026, 7, 22, 7, 0)
const MINUTE = 60_000

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({
    id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).run()
  // Ninety minutes of heart rate, one reading a minute, rising by one beat a minute from 100.
  for (let i = 0; i < 90; i += 1) {
    for (const agg of ['min', 'mean', 'max'] as const) {
      insertSample(test.db, {
        personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
        utcMs: NINE_AM + i * MINUTE, tzOffsetMinutes: OFFSET, agg, value: 100 + i,
      })
    }
  }
  // One more reading at 12:20 local, the same local day but outside every window these tests ask
  // for. It is what lets the thinning test fail: without it the ninety seeded readings ARE the
  // whole day, so an implementation that derived a local date from startMs and read the day would
  // return the same ninety and report the same `from`. With it, a day reader sees 91 where a
  // window reader sees 90, and the 90-point and 45-point counts below break too.
  for (const agg of ['min', 'mean', 'max'] as const) {
    insertSample(test.db, {
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
      utcMs: NINE_AM + 200 * MINUTE, tzOffsetMinutes: OFFSET, agg, value: 70,
    })
  }
})
afterEach(() => test.cleanup())

describe('readIntradayWindow', () => {
  it('answers only the readings inside the window', () => {
    const result = readIntradayWindow(test.db, {
      personId: 'p1', metric: 'heart_rate',
      startMs: NINE_AM + 10 * MINUTE, endMs: NINE_AM + 19 * MINUTE,
    })
    expect(result.points).toHaveLength(10)
    expect(result.points[0]!.utcMs).toBe(NINE_AM + 10 * MINUTE)
    expect(result.points.at(-1)!.utcMs).toBe(NINE_AM + 19 * MINUTE)
    expect(result.points[0]!.mean).toBe(110)
  })

  it('reports no reduction when the window fits the budget', () => {
    const result = readIntradayWindow(test.db, {
      personId: 'p1', metric: 'heart_rate',
      startMs: NINE_AM, endMs: NINE_AM + 89 * MINUTE, points: 500,
    })
    expect(result.points).toHaveLength(90)
    expect(result.reduction).toBeNull()
  })

  it('thins against the window rather than the day, and says so', () => {
    const result = readIntradayWindow(test.db, {
      personId: 'p1', metric: 'heart_rate',
      startMs: NINE_AM, endMs: NINE_AM + 89 * MINUTE, points: 20,
    })
    // Twenty exactly, not merely "at most twenty", and both numbers are established ahead of the
    // run rather than read back off it: thinBand keeps the first and the last point and two per
    // bucket, and a budget of 20 spends floor((20 - 2) / 2) = 9 buckets on the middle. `from` is
    // 90 because the 12:20 reading is outside the window - a day reader would say 91 here.
    expect(result.points).toHaveLength(20)
    expect(result.reduction).toEqual({ method: 'minmax', from: 90, to: 20 })
  })

  it('keeps a reading whose own offset puts it on a different local day', () => {
    // Recorded at -600 rather than +120, which makes its local date 2026-08-21 while every
    // neighbouring reading is on 2026-08-22. Thirty seconds past the minute so it is a row of its
    // own rather than a second `mean` at an instant the fixture already filled.
    const odd = NINE_AM + 30 * MINUTE + 30_000
    insertSample(test.db, {
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
      utcMs: odd, tzOffsetMinutes: -600, agg: 'mean', value: 55,
    })

    const window = readIntradayWindow(test.db, {
      personId: 'p1', metric: 'heart_rate',
      startMs: NINE_AM + 30 * MINUTE, endMs: NINE_AM + 31 * MINUTE,
    })
    expect(window.points.map((p) => p.utcMs))
      .toEqual([NINE_AM + 30 * MINUTE, odd, NINE_AM + 31 * MINUTE])
    expect(window.points[1]!.mean).toBe(55)

    // The mirror, and the whole axis the two readers differ on: readIntraday widens its query past
    // its own day and then narrows each row back by that row's own offset, so it drops this one.
    // The window reader has no day to narrow against and must not.
    const day = readIntraday(test.db, { personId: 'p1', metric: 'heart_rate', localDate: LOCAL_DATE })
    expect(day.points.some((p) => p.utcMs === odd)).toBe(false)
  })

  it('answers nothing for a window with no readings', () => {
    const result = readIntradayWindow(test.db, {
      personId: 'p1', metric: 'heart_rate',
      startMs: NINE_AM - 10 * MINUTE, endMs: NINE_AM - MINUTE,
    })
    expect(result).toEqual({ points: [], reduction: null })
  })
})

describe('PersonQuery.intradayWindow', () => {
  it('refuses a window that ends before it starts', () => {
    const q = new PersonQuery(test.db, 'p1')
    expect(() => q.intradayWindow({ metric: 'heart_rate', startMs: NINE_AM, endMs: NINE_AM - 1 }))
      .toThrow(/startMs .* is after endMs/)
  })

  it('refuses a start that failed to parse to a number', () => {
    const q = new PersonQuery(test.db, 'p1')
    expect(() => q.intradayWindow({ metric: 'heart_rate', startMs: Number.NaN, endMs: NINE_AM }))
      .toThrow(ConfigError)
  })

  it('answers a session shaped window', () => {
    const q = new PersonQuery(test.db, 'p1')
    const result = q.intradayWindow({
      metric: 'heart_rate', startMs: NINE_AM, endMs: NINE_AM + 44 * MINUTE,
    })
    expect(result.points).toHaveLength(45)
  })

  // The reader selects every sample row in the span into JS before pivoting, and a year of heart
  // rate is about 1.5 million of them. `intraday` cannot reach that shape - one local day is its
  // whole argument - so this is the only place the bound can live.
  it('refuses a span wider than 48 hours, naming the limit and the span asked for', () => {
    const q = new PersonQuery(test.db, 'p1')
    const input = { metric: 'heart_rate', startMs: 0, endMs: NINE_AM }
    expect(() => q.intradayWindow(input)).toThrow(ConfigError)
    expect(() => q.intradayWindow(input)).toThrow(/at most 48 hours/)
  })

  it('allows a span of exactly 48 hours', () => {
    // The boundary is inclusive, so a caller who computed the limit themselves is not refused by
    // one millisecond for having got it exactly right.
    const q = new PersonQuery(test.db, 'p1')
    expect(() => q.intradayWindow({
      metric: 'heart_rate', startMs: NINE_AM, endMs: NINE_AM + 48 * 60 * MINUTE,
    })).not.toThrow()
  })

  it('answers the span rather than the limit when the window is reversed', () => {
    // Order, not taste: a reversed window's span is negative, so a cap tested first would let it
    // through, but a wide AND reversed window would be answered with a complaint about a limit it
    // does not exceed. The reversed check has to come first for this message to be reachable.
    const q = new PersonQuery(test.db, 'p1')
    expect(() => q.intradayWindow({ metric: 'heart_rate', startMs: NINE_AM, endMs: 0 }))
      .toThrow(/startMs .* is after endMs/)
  })

  // points is unvalidated everywhere it appears: HTTP catches it in optionalPositiveInt, and a
  // tool caller does not arrive through HTTP. NaN survives Math.max(2, NaN) inside the downsampler
  // and comes back as two points with a reduction claiming `to: 2`, which is a wrong answer stated
  // confidently rather than an error.
  describe('points', () => {
    const bad: Array<[string, unknown]> = [
      ['NaN', Number.NaN], ['zero', 0], ['a negative', -5], ['a fraction', 2.5],
      ['the string "10"', '10'], ['null', null],
    ]

    it.each(bad)('intradayWindow refuses %s', (_label, value) => {
      const q = new PersonQuery(test.db, 'p1')
      const input = {
        metric: 'heart_rate', startMs: NINE_AM, endMs: NINE_AM + 44 * MINUTE, points: value,
      } as unknown as Parameters<PersonQuery['intradayWindow']>[0]
      expect(() => q.intradayWindow(input)).toThrow(ConfigError)
      expect(() => q.intradayWindow(input)).toThrow(/points must be a positive integer/)
    })

    it.each(bad)('intraday refuses %s', (_label, value) => {
      const q = new PersonQuery(test.db, 'p1')
      const input = {
        metric: 'heart_rate', localDate: LOCAL_DATE, points: value,
      } as unknown as Parameters<PersonQuery['intraday']>[0]
      expect(() => q.intraday(input)).toThrow(/points must be a positive integer/)
    })

    it.each(bad)('series refuses %s', (_label, value) => {
      const q = new PersonQuery(test.db, 'p1')
      const input = {
        metric: 'steps', agg: 'sum', from: LOCAL_DATE, to: LOCAL_DATE, points: value,
      } as unknown as Parameters<PersonQuery['series']>[0]
      expect(() => q.series(input)).toThrow(/points must be a positive integer/)
    })

    it('still accepts an absent points, which is not a mistake', () => {
      const q = new PersonQuery(test.db, 'p1')
      expect(q.intradayWindow({
        metric: 'heart_rate', startMs: NINE_AM, endMs: NINE_AM + 44 * MINUTE,
      }).points).toHaveLength(45)
    })
  })
})
