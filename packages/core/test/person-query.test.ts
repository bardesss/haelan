import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { ConfigError } from '../src/errors.ts'
import { daily } from '../src/db/schema/index.ts'

let test: TestDatabase
let query: PersonQuery

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  query = new PersonQuery(test.db, 'p1')
})
afterEach(() => test.cleanup())

const insertDaily = (o: {
  localDate: string, value: number | null, metric?: string, agg?: string,
  source?: string, coverage?: number | null, personId?: string,
}) => {
  test.db.insert(daily).values({
    personId: o.personId ?? 'p1',
    localDate: o.localDate,
    metric: o.metric ?? 'steps',
    agg: o.agg ?? 'sum',
    source: o.source ?? 'merged',
    value: o.value,
    coverage: o.coverage === undefined ? 0.9 : o.coverage,
    sourceMix: null,
    derivationVersion: 4,
  }).run()
}

describe('PersonQuery.series', () => {
  it('returns the days in the range, oldest first', () => {
    insertDaily({ localDate: '2026-08-03', value: 300 })
    insertDaily({ localDate: '2026-08-01', value: 100 })
    insertDaily({ localDate: '2026-08-02', value: 200 })

    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-03' })
    expect(points.map((p) => p.localDate)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
    expect(points.map((p) => p.value)).toEqual([100, 200, 300])
  })

  it('includes both ends of the range', () => {
    insertDaily({ localDate: '2026-08-01', value: 100 })
    insertDaily({ localDate: '2026-08-05', value: 500 })
    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-05' })
    expect(points).toHaveLength(2)
  })

  it('excludes days outside the range', () => {
    insertDaily({ localDate: '2026-07-31', value: 1 })
    insertDaily({ localDate: '2026-08-01', value: 100 })
    insertDaily({ localDate: '2026-08-06', value: 1 })
    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-05' })
    expect(points.map((p) => p.value)).toEqual([100])
  })

  it('reads the merged row by default, because that is the answer to what happened', () => {
    insertDaily({ localDate: '2026-08-01', value: 400, source: 'watch' })
    insertDaily({ localDate: '2026-08-01', value: 900, source: 'merged' })
    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([900])
  })

  it('reads one source when asked, so provenance stays reachable', () => {
    insertDaily({ localDate: '2026-08-01', value: 400, source: 'watch' })
    insertDaily({ localDate: '2026-08-01', value: 900, source: 'merged' })
    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-01', source: 'watch' })
    expect(points.map((p) => p.value)).toEqual([400])
  })

  it('separates aggregates of the same metric', () => {
    insertDaily({ localDate: '2026-08-01', value: 52, metric: 'heart_rate', agg: 'min' })
    insertDaily({ localDate: '2026-08-01', value: 88, metric: 'heart_rate', agg: 'max' })
    const points = query.series({ metric: 'heart_rate', agg: 'max', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([88])
  })

  it('carries coverage through, including a null one', () => {
    insertDaily({ localDate: '2026-08-01', value: 480, metric: 'sleep_asleep_minutes', coverage: null })
    const points = query.series({ metric: 'sleep_asleep_minutes', agg: 'sum', from: '2026-08-01', to: '2026-08-01' })
    expect(points[0]?.coverage).toBeNull()
  })

  it('drops a row with no value, because that is not a measurement', () => {
    // Nothing writes one today: every producer skips a null before it builds a row. The guard
    // is here so a future producer that does cannot silently put a hole in a mean.
    insertDaily({ localDate: '2026-08-01', value: null })
    insertDaily({ localDate: '2026-08-02', value: 200 })
    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-02' })
    expect(points.map((p) => p.value)).toEqual([200])
  })

  it('returns an empty series rather than throwing when there is nothing', () => {
    expect(query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-05' })).toEqual([])
  })

  it('falls back to the provider row for a metric that has no merged one', () => {
    // total_calories and floors are written only as provider rows: Google reconciles them
    // itself and there is no sample underneath either for a merge to work from. Asking what
    // happened that day has to answer with the row that says it.
    insertDaily({ localDate: '2026-08-01', value: 2200, metric: 'total_calories', source: 'provider' })
    const points = query.series({ metric: 'total_calories', agg: 'sum', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([2200])
    expect(points.map((p) => p.source)).toEqual(['provider'])
  })

  it('falls back per row, so one stray merged row cannot hide a provider series', () => {
    insertDaily({ localDate: '2026-08-01', value: 2200, metric: 'total_calories', source: 'provider' })
    insertDaily({ localDate: '2026-08-02', value: 2300, metric: 'total_calories', source: 'provider' })
    insertDaily({ localDate: '2026-08-02', value: 2350, metric: 'total_calories', source: 'merged' })
    const points = query.series({ metric: 'total_calories', agg: 'sum', from: '2026-08-01', to: '2026-08-02' })
    expect(points.map((p) => p.value)).toEqual([2200, 2350])
    expect(points.map((p) => p.source)).toEqual(['provider', 'merged'])
  })

  it('ignores the provider row on a day that has a merged one', () => {
    insertDaily({ localDate: '2026-08-01', value: 900, source: 'merged' })
    insertDaily({ localDate: '2026-08-01', value: 400, source: 'provider' })
    const points = query.series({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: '2026-08-01' })
    expect(points.map((p) => p.value)).toEqual([900])
  })

  it('returns only merged rows when merged is named, so provenance stays askable', () => {
    // Not the same question as the default. This one asks which days we reconciled ourselves.
    insertDaily({ localDate: '2026-08-01', value: 2200, metric: 'total_calories', source: 'provider' })
    insertDaily({ localDate: '2026-08-02', value: 2350, metric: 'total_calories', source: 'merged' })
    const points = query.series({
      metric: 'total_calories', agg: 'sum', from: '2026-08-01', to: '2026-08-02', source: 'merged',
    })
    expect(points.map((p) => p.value)).toEqual([2350])
  })
})

describe('PersonQuery argument validation', () => {
  // Every emptiness these would otherwise return is indistinguishable from "this person has no
  // data", which in M4 becomes an agent stating a false thing about a health record.
  it('refuses an unpadded date rather than silently comparing it as a string', () => {
    // '2026-08-05' >= '2026-8-1' is false, so the whole month would come back empty.
    expect(() => query.series({ metric: 'steps', agg: 'sum', from: '2026-8-1', to: '2026-08-31' }))
      .toThrow(ConfigError)
    expect(() => query.baseline({ metric: 'steps', agg: 'sum', on: '2026-8-1' })).toThrow(ConfigError)
    expect(() => query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-8-1', to: '2026-08-31' }))
      .toThrow(ConfigError)
  })

  it('names the offending value, so a caller can say which argument was wrong', () => {
    expect(() => query.baseline({ metric: 'steps', agg: 'sum', on: '2026-8-1' })).toThrow(/2026-8-1/)
  })

  it('refuses a reversed range rather than returning nothing', () => {
    expect(() => query.series({ metric: 'steps', agg: 'sum', from: '2026-08-31', to: '2026-08-01' }))
      .toThrow(ConfigError)
    expect(() => query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-31', to: '2026-08-01' }))
      .toThrow(ConfigError)
  })

  it('refuses a plainly malformed date in every method', () => {
    expect(() => query.series({ metric: 'steps', agg: 'sum', from: 'last tuesday', to: '2026-08-31' }))
      .toThrow(ConfigError)
    expect(() => query.baseline({ metric: 'steps', agg: 'sum', on: 'last tuesday' })).toThrow(ConfigError)
    expect(() => query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-01', to: 'last tuesday' }))
      .toThrow(ConfigError)
  })

  it('refuses a metric the catalogue does not declare', () => {
    // 'sleep' is the data type id, not a metric. It has no rows and never will.
    expect(() => query.series({ metric: 'sleep', agg: 'sum', from: '2026-08-01', to: '2026-08-07' }))
      .toThrow(ConfigError)
    expect(() => query.baseline({ metric: 'sleep', agg: 'sum', on: '2026-08-07' })).toThrow(ConfigError)
    expect(() => query.comparePeriods({ metric: 'sleep', agg: 'sum', from: '2026-08-01', to: '2026-08-07' }))
      .toThrow(ConfigError)
  })

  it('refuses an aggregate the metric does not declare', () => {
    // Summing heart rate is not a number anyone means, and 'avg' is not what the column is called.
    expect(() => query.series({ metric: 'heart_rate', agg: 'sum', from: '2026-08-01', to: '2026-08-07' }))
      .toThrow(ConfigError)
    expect(() => query.series({ metric: 'heart_rate', agg: 'avg', from: '2026-08-01', to: '2026-08-07' }))
      .toThrow(/mean/)
  })
})

describe('PersonQuery.baseline', () => {
  const seedRun = (fromDay: number, count: number, value: (at: number) => number) => {
    for (let at = 0; at < count; at += 1) {
      insertDaily({ localDate: `2026-08-${String(fromDay + at).padStart(2, '0')}`, value: value(at) })
    }
  }

  it('averages the window ending the day before the date asked about', () => {
    // Five days at 10, then a wild reading on the sixth. The baseline for the sixth must not
    // contain it, or the reading would be judged against a centre it moved itself.
    seedRun(1, 5, () => 10)
    insertDaily({ localDate: '2026-08-06', value: 1000 })

    const baseline = query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-06', windowDays: 5 })
    expect(baseline?.center).toBeCloseTo(10, 10)
    expect(baseline?.n).toBe(5)
  })

  it('reaches back exactly the window it was given', () => {
    seedRun(1, 10, (at) => at)
    // Window of 3 ending on the day before the 8th: the 5th, 6th and 7th, values 4, 5 and 6.
    const baseline = query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-08', windowDays: 3 })
    expect(baseline?.n).toBe(3)
    expect(baseline?.center).toBeCloseTo(5, 10)
  })

  it('defaults to the stated window', () => {
    seedRun(1, 10, () => 100)
    const baseline = query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-20' })
    // The default reaches far enough back to include all ten days and finds no more.
    expect(baseline?.n).toBe(10)
  })

  it('marks a short history thin rather than pretending', () => {
    seedRun(1, 3, () => 100)
    expect(query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-20' })?.thin).toBe(true)
  })

  it('returns null when there is no history at all', () => {
    expect(query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-20' })).toBeNull()
  })

  it('counts only the days that have a row, so a gap is absent rather than zero', () => {
    insertDaily({ localDate: '2026-08-01', value: 10 })
    insertDaily({ localDate: '2026-08-05', value: 20 })
    const baseline = query.baseline({ metric: 'steps', agg: 'sum', on: '2026-08-10', windowDays: 60 })
    expect(baseline?.n).toBe(2)
    expect(baseline?.center).toBeCloseTo(15, 10)
  })

  it('drops barely worn days for a metric whose coverage says something', () => {
    // A watch worn only in the mornings gives a day at 0.2 coverage whose mean is a systematic
    // undercount, not a low reading. Left in, the centre sinks and the first properly worn day
    // scores a large positive z, which is a wear artefact reported as a health signal.
    for (let at = 0; at < 10; at += 1) {
      insertDaily({
        localDate: `2026-08-${String(1 + at).padStart(2, '0')}`,
        value: 60, metric: 'heart_rate', agg: 'mean', coverage: 0.9,
      })
      insertDaily({
        localDate: `2026-08-${String(11 + at).padStart(2, '0')}`,
        value: 30, metric: 'heart_rate', agg: 'mean', coverage: 0.2,
      })
    }
    const baseline = query.baseline({ metric: 'heart_rate', agg: 'mean', on: '2026-08-21', windowDays: 20 })
    expect(baseline?.n).toBe(10)
    expect(baseline?.center).toBeCloseTo(60, 10)
  })

  it('keeps every day for a metric whose coverage is not a quality signal', () => {
    // resting_heart_rate arrives once a day, so a perfect day reads 1/24. Dropping those would
    // leave the metric behind the product's flagship example question with no baseline at all.
    for (let at = 0; at < 20; at += 1) {
      insertDaily({
        localDate: `2026-08-${String(1 + at).padStart(2, '0')}`,
        value: 58, metric: 'resting_heart_rate', agg: 'last', coverage: 1 / 24,
      })
    }
    const baseline = query.baseline({ metric: 'resting_heart_rate', agg: 'last', on: '2026-08-21', windowDays: 20 })
    expect(baseline?.n).toBe(20)
    expect(baseline?.thin).toBe(false)
  })

  it('keeps a day whose coverage is null, because null is not a zero', () => {
    for (let at = 0; at < 20; at += 1) {
      insertDaily({
        localDate: `2026-08-${String(1 + at).padStart(2, '0')}`,
        value: 420, metric: 'sleep_asleep_minutes', coverage: null,
      })
    }
    const baseline = query.baseline({ metric: 'sleep_asleep_minutes', agg: 'sum', on: '2026-08-21', windowDays: 20 })
    expect(baseline?.n).toBe(20)
  })
})

describe('PersonQuery.comparePeriods', () => {
  const seedWeek = (fromDay: number, value: number, coverage: number | null = 0.9) => {
    for (let at = 0; at < 7; at += 1) {
      insertDaily({
        localDate: `2026-08-${String(fromDay + at).padStart(2, '0')}`, value, coverage,
      })
    }
  }

  it('compares a week against the week immediately before it', () => {
    seedWeek(1, 80)
    seedWeek(8, 100)
    const insight = query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-08', to: '2026-08-14' })
    expect(insight.current).toBeCloseTo(100, 10)
    expect(insight.previous).toBeCloseTo(80, 10)
    expect(insight.delta).toBeCloseTo(20, 10)
    expect(insight.periodDays).toBe(7)
    expect(insight.suppressed).toBe(false)
  })

  it('suppresses when the current week is full of holes', () => {
    seedWeek(1, 80)
    insertDaily({ localDate: '2026-08-08', value: 100 })
    insertDaily({ localDate: '2026-08-09', value: 100 })
    const insight = query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-08', to: '2026-08-14' })
    expect(insight.suppressed).toBe(true)
    expect(insight.reason).toBe('thin-days')
    expect(insight.delta).toBeNull()
  })

  it('does not suppress a sleep comparison for having null coverage', () => {
    // Every sleep row carries a null coverage on purpose. If that counted as zero, the sleep
    // page would never show an insight at all, which is the opposite of what the rule is for.
    for (let at = 0; at < 7; at += 1) {
      insertDaily({ localDate: `2026-08-${String(1 + at).padStart(2, '0')}`, value: 420, metric: 'sleep_asleep_minutes', coverage: null })
      insertDaily({ localDate: `2026-08-${String(8 + at).padStart(2, '0')}`, value: 480, metric: 'sleep_asleep_minutes', coverage: null })
    }
    const insight = query.comparePeriods({ metric: 'sleep_asleep_minutes', agg: 'sum', from: '2026-08-08', to: '2026-08-14' })
    expect(insight.suppressed).toBe(false)
    expect(insight.delta).toBeCloseTo(60, 10)
  })

  it('measures the previous period as the same number of days, immediately before', () => {
    // A three day window ending the 10th compares against the 5th to the 7th, not against a
    // week or a calendar month.
    for (const day of [5, 6, 7]) insertDaily({ localDate: `2026-08-0${day}`, value: 10 })
    for (const day of [8, 9]) insertDaily({ localDate: `2026-08-0${day}`, value: 20 })
    insertDaily({ localDate: '2026-08-10', value: 20 })
    const insight = query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-08', to: '2026-08-10' })
    expect(insight.periodDays).toBe(3)
    expect(insight.previousDays).toBe(3)
    expect(insight.previous).toBeCloseTo(10, 10)
    expect(insight.current).toBeCloseTo(20, 10)
  })

  it('does not suppress a once-a-day metric for reading one hour in twenty four', () => {
    // resting_heart_rate arrives once a day, so coverage is 1/24 = 0.0417 on a perfect week.
    // Judged against a threshold of 0.5 it was suppressed always and forever, which blanked the
    // whole Recovery page and the metric behind the product's own flagship example question.
    for (let at = 0; at < 7; at += 1) {
      insertDaily({
        localDate: `2026-08-${String(1 + at).padStart(2, '0')}`,
        value: 58, metric: 'resting_heart_rate', agg: 'last', coverage: 1 / 24,
      })
      insertDaily({
        localDate: `2026-08-${String(8 + at).padStart(2, '0')}`,
        value: 62, metric: 'resting_heart_rate', agg: 'last', coverage: 1 / 24,
      })
    }
    const insight = query.comparePeriods({
      metric: 'resting_heart_rate', agg: 'last', from: '2026-08-08', to: '2026-08-14',
    })
    expect(insight.suppressed).toBe(false)
    expect(insight.delta).toBeCloseTo(4, 10)
    // Null rather than 0.0417: the number exists in the row and means nothing about quality here.
    expect(insight.currentCoverage).toBeNull()
  })

  it('still suppresses a continuously sampled metric that was barely worn', () => {
    // heart_rate is sampled all day, so 0.1 is a watch worn for a couple of hours and its mean
    // is an artefact. The gate has to keep working exactly where coverage does mean something.
    for (let at = 0; at < 7; at += 1) {
      insertDaily({
        localDate: `2026-08-${String(1 + at).padStart(2, '0')}`,
        value: 58, metric: 'heart_rate', agg: 'mean', coverage: 0.1,
      })
      insertDaily({
        localDate: `2026-08-${String(8 + at).padStart(2, '0')}`,
        value: 62, metric: 'heart_rate', agg: 'mean', coverage: 0.1,
      })
    }
    const insight = query.comparePeriods({
      metric: 'heart_rate', agg: 'mean', from: '2026-08-08', to: '2026-08-14',
    })
    expect(insight.suppressed).toBe(true)
    expect(insight.reason).toBe('thin-coverage')
    expect(insight.currentCoverage).toBeCloseTo(0.1, 10)
  })

  it('says which two ranges it compared, so nothing downstream re-derives them', () => {
    seedWeek(1, 80)
    seedWeek(8, 100)
    const insight = query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-08', to: '2026-08-14' })
    expect(insight.currentRange).toEqual({ from: '2026-08-08', to: '2026-08-14' })
    expect(insight.previousRange).toEqual({ from: '2026-08-01', to: '2026-08-07' })
    expect(insight.currentCoverage).toBeCloseTo(0.9, 10)
    expect(insight.previousCoverage).toBeCloseTo(0.9, 10)
  })

  it('still says what it compared when it refuses, because that is the explanation', () => {
    seedWeek(1, 80)
    insertDaily({ localDate: '2026-08-08', value: 100 })
    const insight = query.comparePeriods({ metric: 'steps', agg: 'sum', from: '2026-08-08', to: '2026-08-14' })
    expect(insight.suppressed).toBe(true)
    expect(insight.currentRange).toEqual({ from: '2026-08-08', to: '2026-08-14' })
    expect(insight.previousRange).toEqual({ from: '2026-08-01', to: '2026-08-07' })
    expect(insight.currentDays).toBe(1)
    expect(insight.previousDays).toBe(7)
    expect(insight.currentCoverage).toBeCloseTo(0.9, 10)
    expect(insight.delta).toBeNull()
  })
})

describe('PersonQuery date validation, out of range components', () => {
  // The format check alone lets '2026-13-45' through: it is four digits, two, two. The three
  // methods then diverge, which is the exact failure the padded-month check was added to end.
  // series compares it as a string and finds nothing, while the other two hand it to Date.parse,
  // get NaN, and throw a RangeError from three frames down. The consumers here are an HTTP query
  // string and a language model picking tool arguments, so an off by one month is ordinary.
  const nonsense = ['2026-13-01', '2026-00-15', '2026-02-30', '2026-01-32', '2026-01-00']

  it('refuses an impossible month or day from series', () => {
    for (const on of nonsense) {
      expect(() => query.series({ metric: 'steps', agg: 'sum', from: on, to: '2026-08-28' }), on)
        .toThrow(ConfigError)
    }
  })

  it('refuses an impossible month or day from baseline', () => {
    for (const on of nonsense) {
      expect(() => query.baseline({ metric: 'steps', agg: 'sum', on }), on).toThrow(ConfigError)
    }
  })

  it('refuses an impossible month or day from comparePeriods', () => {
    for (const on of nonsense) {
      expect(() => query.comparePeriods({ metric: 'steps', agg: 'sum', from: on, to: '2026-08-28' }), on)
        .toThrow(ConfigError)
    }
  })

  it('still accepts a real leap day, so the check rejects only what the calendar rejects', () => {
    // 2028 is a leap year and 2026 is not. A round trip check that simply reformatted the parsed
    // date would pass both, so this is what proves it compares against the calendar.
    expect(() => query.series({ metric: 'steps', agg: 'sum', from: '2028-02-29', to: '2028-03-01' }))
      .not.toThrow()
    expect(() => query.series({ metric: 'steps', agg: 'sum', from: '2026-02-29', to: '2026-03-01' }))
      .toThrow(ConfigError)
  })
})
