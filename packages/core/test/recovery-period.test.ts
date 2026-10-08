import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sources } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { ConfigError } from '../src/errors.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { carriedByOf, readRecoveryPeriod } from '../src/query/recoveryPeriod.ts'
import type { RecoveryDay, RecoveryPeriodInput } from '../src/query/recoveryPeriod.ts'
import { recoveryIndexFigure } from '../src/query/recoveryIndexFigure.ts'
import { periodUsual } from '../src/query/periodFigure.ts'
import { readSpan } from '../src/query/periodRead.ts'
import { datesIn, periodBounds, weeksIn } from '../src/query/periodBounds.ts'
import type { PeriodRange } from '../src/query/periodBounds.ts'
import { BASELINE_WINDOW_DAYS } from '../src/query/baseline.ts'
import { bandOf, RECOVERY_USUAL_BAND, RECOVERY_WEIGHTS } from '../src/api/recoveryIndex.ts'
import {
  HRV_DEVIATION_BAND, HRV_DEVIATION_LOOKBACK_DAYS, HRV_DEVIATION_MIN_RUN, HRV_WEEK_DAYS, HRV_WEEK_MIN_READINGS,
} from '../src/query/hrvDeviation.ts'

// Synthetic mornings only, daily rows as the derive step stores them. Every series alternates either
// side of a round level, so every baseline has a spread and no week leans to one side.
const TODAY = '2026-09-20'
const FIRST = '2024-10-01'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  for (const id of ['a', 'b']) {
    test.db.insert(sources).values({ id, personId: 'p1', externalId: id, displayName: id, kind: 'device', createdAtMs: 0 }).run()
  }
})
afterEach(() => test.cleanup())

const q = () => new PersonQuery(test.db, 'p1')
const input = (o: Partial<RecoveryPeriodInput> & { range: PeriodRange, anchor: string }): RecoveryPeriodInput => ({ today: TODAY, ...o })

function seed(metric: string, value: (date: string, i: number) => number | null, o: { from?: string, to?: string, source?: string } = {}) {
  const rows = datesIn({ from: o.from ?? FIRST, to: o.to ?? TODAY }).flatMap((localDate, i) => {
    const v = value(localDate, i)
    return v === null ? [] : [{
      personId: 'p1', localDate, metric, agg: 'last', source: o.source ?? 'merged', value: v, coverage: 1,
      sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }]
  })
  for (let i = 0; i < rows.length; i += 200) test.db.insert(daily).values(rows.slice(i, i + 200)).run()
}

const swing = (i: number, by: number) => (i % 2 === 0 ? by : -by)
const hrvAt = (level: number) => (_: string, i: number) => level + swing(i, 3)
const rhrAt = (level: number) => (_: string, i: number) => level + swing(i, 1)

/** HRV around 45 and resting heart rate around 55 every day, unless a test overrides one. */
function seedMornings(o: { hrv?: (date: string, i: number) => number | null, rhr?: (date: string, i: number) => number | null, hrvTo?: string } = {}) {
  seed('daily_hrv', o.hrv ?? hrvAt(45), { to: o.hrvTo })
  seed('resting_heart_rate', o.rhr ?? rhrAt(55))
}

const usualDayBand = { center: (RECOVERY_USUAL_BAND.low + RECOVERY_USUAL_BAND.high) / 2, low: RECOVERY_USUAL_BAND.low, high: RECOVERY_USUAL_BAND.high, thin: false }

describe('readRecoveryPeriod', () => {
  it('returns a header and the index as its hero for every range', () => {
    seedMornings()
    for (const [range, from, to] of [
      ['week', '2026-08-10', '2026-08-16'], ['month', '2026-08-01', '2026-08-31'],
      ['3months', '2026-06-01', '2026-08-31'], ['year', '2026-01-01', '2026-12-31'],
    ] as const) {
      const page = readRecoveryPeriod(q(), input({ range, anchor: '2026-08-15' }))
      expect(page.period.range).toBe(range)
      expect([page.period.from, page.period.to]).toEqual([from, to])
      expect(page.hero.metric).toBe('recovery_index')
      expect(page.hero.days).toBeGreaterThan(0)
    }
  })

  it('counts a running period to today', () => {
    seedMornings()
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-09-10' }))
    expect(page.period).toEqual({ range: 'month', from: '2026-09-01', to: '2026-09-30', today: TODAY, periodDays: 30, daysSoFar: 20, partial: true })
    expect(page.days.at(-1)!.localDate).toBe(TODAY)
  })

  it('lists every scored day oldest first, each in the band bandOf gives its score, matching the hero', () => {
    seedMornings()
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.days.map((d) => d.localDate)).toEqual(datesIn({ from: '2026-08-01', to: '2026-08-31' }))
    for (const day of page.days) {
      expect(day.band).toBe(bandOf(day.score))
      expect(page.hero.daily.find((p) => p.from === day.localDate)!.value).toBe(day.score)
      expect(day.inputs.map((x) => x.key)).toEqual(['hrv', 'restingHeartRate'])
    }
  })

  it('names the highest and the lowest scored day', () => {
    seedMornings()
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    const scores = page.days.map((d) => d.score)
    const max = Math.max(...scores)
    const min = Math.min(...scores)
    expect(page.high).toEqual({ localDate: page.days.find((d) => d.score === max)!.localDate, value: max, good: max > RECOVERY_USUAL_BAND.high })
    expect(page.low).toEqual({ localDate: page.days.find((d) => d.score === min)!.localDate, value: min, good: false })
  })

  it('says HRV carried a month where HRV dipped far', () => {
    seedMornings({ hrv: (d, i) => (d >= '2026-08-01' && d <= '2026-08-31' ? 30 : 45) + swing(i, 3) })
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.hero.value).toBeLessThan(50)
    expect(page.carriedBy).toBe('hrv')
  })

  it('says resting heart rate carried a shifted month while HRV swung against it', () => {
    // HRV's low mornings are resting heart rate's low ones: the case summed points named HRV for.
    seedMornings({ rhr: (d, i) => (d >= '2026-08-01' && d <= '2026-08-31' ? 65 : 55) + swing(i, 1) })
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.hero.value).toBeLessThan(50)
    expect(page.carriedBy).toBe('restingHeartRate')
  })

  it('says resting heart rate carried a shifted month while HRV only alternated with it', () => {
    seedMornings({ rhr: (d, i) => (d >= '2026-08-01' && d <= '2026-08-31' ? 65 : 55) - swing(i, 1) })
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.hero.value).toBeLessThan(50)
    expect(page.carriedBy).toBe('restingHeartRate')
  })

  it('carries nothing when nothing is scored', () => {
    seed('daily_hrv', hrvAt(45), { to: '2026-06-30' })
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.hero.value).toBeNull()
    expect(page.carriedBy).toBeNull()
    expect(page.days).toEqual([])
    expect(page.high).toBeNull()
    expect(page.low).toBeNull()
  })

  it('narrows the three figure rows to a source, never the hero', () => {
    seedMornings()
    seed('resting_heart_rate', () => 50, { source: 'a' })
    seed('resting_heart_rate', () => 70, { source: 'b' })
    const merged = q().recoveryPeriod(input({ range: 'month', anchor: '2026-08-15' }))
    const narrowed = q().recoveryPeriod(input({ range: 'month', anchor: '2026-08-15', source: 'b' }))
    expect(narrowed.hero).toEqual(merged.hero)
    expect(narrowed.days).toEqual(merged.days)
    expect(narrowed.figures.map((f) => [f.metric, f.value])).toEqual([['resting_heart_rate', 70]])
    expect(merged.figures.map((f) => f.metric)).toEqual(['resting_heart_rate', 'daily_hrv'])
    expect(merged.figures[0]!.value).not.toBe(70)
  })

  it('reads the breathing rate, falling back to the sleeping rate when there is none', () => {
    seedMornings()
    seed('sleep_respiratory_rate', () => 15)
    const fallback = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(fallback.figures.map((f) => f.metric)).toEqual(['resting_heart_rate', 'daily_hrv', 'sleep_respiratory_rate'])
    seed('respiratory_rate', () => 14)
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.figures.map((f) => [f.metric, f.value])).toEqual([['resting_heart_rate', expect.any(Number)], ['daily_hrv', expect.any(Number)], ['respiratory_rate', 14]])
  })

  it('reads the method from the constants', () => {
    seedMornings()
    const page = readRecoveryPeriod(q(), input({ range: 'week', anchor: '2026-08-15' }))
    expect(page.method).toEqual({
      weights: RECOVERY_WEIGHTS,
      usualBand: { low: RECOVERY_USUAL_BAND.low, high: RECOVERY_USUAL_BAND.high },
      baselineDays: BASELINE_WINDOW_DAYS,
      stretch: {
        weekDays: HRV_WEEK_DAYS, minReadings: HRV_WEEK_MIN_READINGS, band: HRV_DEVIATION_BAND,
        minRun: HRV_DEVIATION_MIN_RUN, lookbackDays: HRV_DEVIATION_LOOKBACK_DAYS,
      },
    })
  })

  it('keeps the period-length usual for the hero and its weeks, the usual band for its days only', () => {
    seedMornings()
    const anchor = '2026-08-15'
    const page = readRecoveryPeriod(q(), input({ range: '3months', anchor }))
    const bounds = periodBounds('3months', anchor)
    const { scores } = recoveryIndexFigure(q(), { range: '3months', anchor, bounds, span: readSpan('3months', bounds), lastDay: '2026-08-31' })
    const values = new Map([...scores].map(([date, day]) => [date, day.score] as const))

    // The hero's usual is the four three-month blocks before it, not the constant band.
    expect(page.hero.usual).toEqual(periodUsual(values, '3months', bounds, 1))
    expect(page.hero.usual!.periods).toBe(4)
    expect([page.hero.usual!.low, page.hero.usual!.high]).not.toEqual([RECOVERY_USUAL_BAND.low, RECOVERY_USUAL_BAND.high])

    // A week point against the twelve weeks before it; its days against the constant band.
    const week = page.hero.weekly![3]!
    const own = periodUsual(values, 'week', periodBounds('week', week.from), 1)!
    expect(week.band).toEqual({ center: own.center, low: own.low, high: own.high, thin: own.thin })
    expect(week.band).not.toEqual(usualDayBand)
    const days = page.hero.daily.filter((p) => p.from >= week.from && p.from <= week.to)
    expect(days.map((p) => p.band)).toEqual(Array(7).fill(usualDayBand))
  })
})

describe('readRecoveryPeriod stretch', () => {
  it('holds one run for a ten-day HRV dip, from its first measured day to its last', () => {
    // The dip runs 10 to 19 August and HRV stops after it, so the run ends where the week turns thin.
    seedMornings({ hrv: (d, i) => (d >= '2026-08-10' ? 30 : 45) + swing(i, 3), hrvTo: '2026-08-19' })
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.stretch!.runs).toEqual([{ from: '2026-08-10', to: '2026-08-22', side: 'below' }])
    expect(page.stretch!.days.map((d) => d.localDate)).toEqual(datesIn({ from: '2026-08-01', to: '2026-08-31' }))
    expect(page.stretch!.days.filter((d) => d.measured && d.side === 'below').map((d) => d.localDate))
      .toEqual(datesIn({ from: '2026-08-10', to: '2026-08-22' }))
    // The last day of the month is unmeasured, so there is no run as of it.
    expect(page.stretch!.run).toBeNull()
  })

  it('clips a run that started before the period to its first day', () => {
    seedMornings({ hrv: (d, i) => (d >= '2026-07-27' ? 30 : 45) + swing(i, 3), hrvTo: '2026-08-05' })
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.stretch!.runs).toEqual([{ from: '2026-08-01', to: '2026-08-08', side: 'below' }])
  })

  it('keeps a run whose measured days are mostly before the period', () => {
    seedMornings({ hrv: (d, i) => (d >= '2026-07-20' ? 30 : 45) + swing(i, 3), hrvTo: '2026-07-29' })
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.stretch!.runs).toEqual([{ from: '2026-08-01', to: '2026-08-01', side: 'below' }])
  })

  it('names the run as of the last day while it lasts', () => {
    seedMornings({ hrv: (d, i) => (d >= '2026-08-20' ? 30 : 45) + swing(i, 3) })
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.stretch!.run).toMatchObject({ side: 'below', since: '2026-08-20', days: 12 })
    expect(page.stretch!.runs).toEqual([{ from: '2026-08-20', to: '2026-08-31', side: 'below' }])
  })

  it('is null when no day of the period is measured', () => {
    seedMornings({ hrvTo: '2026-06-30' })
    const page = readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.stretch).toBeNull()
  })

  it('has weeks on 3 months and a year only, each holding its last measured day', () => {
    seedMornings()
    expect(readRecoveryPeriod(q(), input({ range: 'week', anchor: '2026-08-15' })).stretch!.weeks).toBeNull()
    expect(readRecoveryPeriod(q(), input({ range: 'month', anchor: '2026-08-15' })).stretch!.weeks).toBeNull()
    const page = readRecoveryPeriod(q(), input({ range: '3months', anchor: '2026-08-15' }))
    const weeks = page.stretch!.weeks!
    expect(weeks.map((w) => [w.from, w.to])).toEqual(weeksIn({ from: '2026-06-01', to: '2026-08-31' }).map((w) => [w.from, w.to]))
    for (const week of weeks) {
      const last = page.stretch!.days.filter((d) => d.measured && d.localDate >= week.from && d.localDate <= week.to).at(-1)
      expect(week.point).toEqual(last)
      expect(week.point!.localDate).toBe(week.to)
    }
  })
})

describe('carriedByOf', () => {
  const day = (localDate: string, contributions: Partial<Record<'hrv' | 'restingHeartRate' | 'sleep' | 'respiratoryRate', number>>): RecoveryDay => ({
    localDate, score: 40, band: 'usual',
    inputs: Object.entries(contributions).map(([key, contribution]) => ({ key: key as RecoveryDay['inputs'][number]['key'], weight: 0.25, points: 0, contribution: contribution! })),
  })

  it('names the input with at least half the push the way the hero leans', () => {
    const days = [day('2026-08-01', { hrv: -1, restingHeartRate: -0.5 }), day('2026-08-02', { hrv: -1, restingHeartRate: -0.5 })]
    expect(carriedByOf(days, 40)).toBe('hrv')
    // Exactly half is enough.
    expect(carriedByOf([day('2026-08-01', { hrv: -1, restingHeartRate: -0.5, sleep: -0.5 })], 40)).toBe('hrv')
  })

  it('names none when no input reaches half', () => {
    expect(carriedByOf([day('2026-08-01', { hrv: -1, restingHeartRate: -1, sleep: -1 })], 40)).toBeNull()
  })

  it('names none when two inputs tie for the largest push', () => {
    expect(carriedByOf([day('2026-08-01', { hrv: -1, restingHeartRate: -1 })], 40)).toBeNull()
    // A tie survives float noise: 0.1 + 0.2 against 0.3.
    expect(carriedByOf([day('2026-08-01', { hrv: -0.1, restingHeartRate: -0.3 }), day('2026-08-02', { hrv: -0.2 })], 40)).toBeNull()
  })

  it('reads the direction from the hero and leaves out inputs pushing the other way', () => {
    const days = [day('2026-08-01', { hrv: 2, restingHeartRate: -3, sleep: 1 })]
    expect(carriedByOf(days, 60)).toBe('hrv')
    expect(carriedByOf(days, 40)).toBe('restingHeartRate')
    expect(carriedByOf(days, null)).toBeNull()
    expect(carriedByOf([day('2026-08-01', { hrv: 1 })], 40)).toBeNull()
  })
})

describe('PersonQuery.recoveryPeriod', () => {
  it('refuses the day range, which is not a period', () => {
    expect(() => q().recoveryPeriod(input({ range: 'day' as PeriodRange, anchor: '2026-08-15' }))).toThrow(ConfigError)
  })

  it('refuses a period that starts after today', () => {
    expect(() => q().recoveryPeriod(input({ range: 'month', anchor: '2026-10-15' }))).toThrow(ConfigError)
  })
})
