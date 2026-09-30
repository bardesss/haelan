import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, overrides, sessions, sources } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { shiftLocalDate } from '../src/derive/localDay.ts'
import { sessionTarget } from '../src/derive/targetKey.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { readActivityPeriod } from '../src/query/activityPeriod.ts'
import type { ActivityPeriodInput } from '../src/query/activityPeriod.ts'
import { datesIn, daysIn, periodBounds } from '../src/query/periodBounds.ts'

// Synthetic days and workouts only. Every daily series runs the 400 days from FIRST through TODAY,
// a Wednesday, so August 2026 has eleven whole earlier months behind it (August 2025 starts too late).
const TODAY = '2026-09-23'
const FIRST = shiftLocalDate(TODAY, -399)
const OFFSET = 120
const AUGUST = { range: 'month', anchor: '2026-08-15' } as const

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  for (const id of ['watch', 'b']) {
    test.db.insert(sources).values({ id, personId: 'p1', externalId: id, displayName: id, kind: 'device', createdAtMs: 0 }).run()
  }
})
afterEach(() => test.cleanup())

const q = () => new PersonQuery(test.db, 'p1')
const input = (o: Partial<ActivityPeriodInput> & Pick<ActivityPeriodInput, 'range' | 'anchor'>): ActivityPeriodInput => ({ today: TODAY, ...o })

/** A hundred steps either way on alternate days, so every usual has a spread. */
const jitter = (date: string) => (Number(date.slice(8, 10)) % 2 === 0 ? 100 : -100)

function seedSeries(metric: string, value: (date: string) => number | null, o: { from?: string, to?: string, agg?: string } = {}) {
  const rows = datesIn({ from: o.from ?? FIRST, to: o.to ?? TODAY }).flatMap((localDate) => {
    const v = value(localDate)
    return v === null ? [] : [{
      personId: 'p1', localDate, metric, agg: o.agg ?? 'sum', source: 'merged', value: v, coverage: 1,
      sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }]
  })
  for (let i = 0; i < rows.length; i += 200) test.db.insert(daily).values(rows.slice(i, i + 200)).run()
}

function seedLast(metric: string, points: Record<string, number>) {
  test.db.insert(daily).values(Object.entries(points).map(([localDate, value]) => ({
    personId: 'p1', localDate, metric, agg: 'last', source: 'merged', value, coverage: 1,
    sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
  }))).run()
}

/** Steps, the three activity levels, distance and floors: the days the page reads. */
function seedDays(o: { from?: string, steps?: (date: string) => number } = {}) {
  seedSeries('steps', o.steps ?? ((d) => 8000 + jitter(d)), o)
  seedSeries('active_minutes_light', () => 20, o)
  seedSeries('active_minutes_moderate', () => 10, o)
  seedSeries('active_minutes_vigorous', () => 0, o)
  seedSeries('distance', () => 6_000_000, o)
  seedSeries('floors', () => 8, o)
}

/** The keys mapSessions writes into every session's attrs, null where the payload had none. */
function attrsOf(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    type: null, mainSleep: null, stagesStatus: null, summary: null, metricsSummary: null,
    shortAwakenings: null, exerciseType: null, splits: null, splitSummaries: null,
    exerciseEvents: null, activeDuration: null, displayName: null, notes: null,
    exerciseMetadata: null, routeConsentRequired: null, ...fields,
  }
}

function seedWorkout(localDate: string, type: string | null, o: {
  sourceId?: string, hour?: string, distanceMm?: number, excluded?: boolean, extra?: Record<string, unknown>
} = {}) {
  const sourceId = o.sourceId ?? 'watch'
  const id = `${sourceId}-${type ?? 'untyped'}-${localDate}-${o.hour ?? '07'}`
  const startMs = Date.parse(`${localDate}T${o.hour ?? '07'}:00:00Z`) - OFFSET * 60_000
  test.db.insert(sessions).values({
    id, personId: 'p1', sourceId, kind: 'exercise', externalId: id,
    startMs, startOffsetMinutes: OFFSET, endMs: startMs + 40 * 60_000, endOffsetMinutes: OFFSET, localDate, rawPayloadId: null,
    attrs: JSON.stringify(attrsOf({
      exerciseType: type, activeDuration: '1800s',
      metricsSummary: {
        caloriesKcal: 300, ...(o.distanceMm === undefined ? {} : { distanceMillimeters: o.distanceMm }), ...o.extra,
      },
    })),
  }).run()
  if (o.excluded) {
    test.db.insert(overrides).values({
      id: `o-${id}`, personId: 'p1', scope: 'session', targetKey: sessionTarget(id),
      action: 'exclude', reason: 'duplicate', correctedValue: null, createdAtMs: 0,
    }).run()
  }
  return id
}

/** Three runs and a walk in August 2026, one more run excluded, and two runs in each earlier month. */
function seedAugustWorkouts(earlierMonths: readonly string[] = monthsBefore('2026-08', 12)) {
  seedWorkout('2026-08-03', 'RUNNING', { distanceMm: 5_000_000 })
  seedWorkout('2026-08-10', 'RUNNING', { distanceMm: 7_000_000 })
  seedWorkout('2026-08-17', 'RUNNING')
  seedWorkout('2026-08-20', 'WALKING')
  seedWorkout('2026-08-24', 'RUNNING', { excluded: true })
  for (const month of earlierMonths) {
    seedWorkout(`${month}-05`, 'RUNNING')
    seedWorkout(`${month}-19`, 'RUNNING')
  }
}

/** The usual of `perMonth` workouts a month, each month's count scaled to a period of `periodDays`. */
function scaledCenter(months: readonly string[], perMonth: number, periodDays: number): number {
  const scaled = months.map((m) => perMonth * periodDays / daysIn(periodBounds('month', `${m}-01`)))
  return scaled.reduce((s, v) => s + v, 0) / scaled.length
}

function monthsBefore(month: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 - (n - i), 1))
    return d.toISOString().slice(0, 7)
  })
}

describe('readActivityPeriod', () => {
  it('never judges today, but lists the workout started today', () => {
    seedDays()
    const id = seedWorkout(TODAY, 'RUNNING')
    const page = readActivityPeriod(q(), input({ range: 'week', anchor: TODAY }))
    expect(page.period).toMatchObject({ from: '2026-09-21', to: '2026-09-27', daysSoFar: 2, partial: true })
    expect(page.hero.daily.map((d) => d.from)).toEqual(['2026-09-21', '2026-09-22'])
    expect(page.hero.days).toBe(2)
    expect(page.workouts.map((w) => w.id)).toEqual([id])
    expect(page.workoutCount).toBe(1)
  })

  it('states the steps: the busiest day, and the month before and a year earlier', () => {
    seedDays({ steps: (d) => (d === '2026-08-12' ? 15_000 : 8000 + jitter(d)) })
    const page = readActivityPeriod(q(), input(AUGUST))
    expect(page.hero.metric).toBe('steps')
    expect(page.period).toMatchObject({ daysSoFar: 31, partial: false })
    expect(page.high).toMatchObject({ localDate: '2026-08-12' })
    expect(page.previous).toMatchObject({ from: '2026-07-01', to: '2026-07-31' })
    expect(page.yearEarlier).toMatchObject({ from: '2025-08-01', to: '2025-08-31' })
    expect(page.previous.delta).not.toBeNull()
  })

  it('states active minutes per week: the three levels summed a day, and their total', () => {
    seedDays()
    const page = readActivityPeriod(q(), input(AUGUST))
    const active = page.figures.find((f) => f.metric === 'active_minutes')!
    expect(active).toMatchObject({ per: 'week', unit: 'minutes', value: 210, total: 30 * 31, days: 31 })
    // A day's point is that day's own minutes, not seven times them.
    expect(active.daily[0]!.value).toBe(30)
    // Banded in memory from the summed days, as `baselines` would: 30 every day sits within its own band.
    expect(active.daily[0]!.band).toMatchObject({ center: 30 })
    expect(active.daily[0]!.standing).toBe('within')
    expect(page.figures.map((f) => f.metric)).toEqual(['active_minutes', 'distance', 'floors'])
    expect(page.intensity.light?.value).toBe(20)
    expect(page.intensity.vigorous?.value).toBe(0)
  })

  it('counts the workouts without the excluded one, and lists that one marked, newest first', () => {
    seedDays()
    seedAugustWorkouts()
    const page = readActivityPeriod(q(), input(AUGUST))
    expect(page.workoutCount).toBe(4)
    expect(page.workouts.map((w) => [w.localDate, w.type, w.excluded])).toEqual([
      ['2026-08-24', 'RUNNING', true],
      ['2026-08-20', 'WALKING', false],
      ['2026-08-17', 'RUNNING', false],
      ['2026-08-10', 'RUNNING', false],
      ['2026-08-03', 'RUNNING', false],
    ])
    expect(page.workouts[0]).toMatchObject({ sourceId: 'watch', durationSeconds: 1800, caloriesKcal: 300 })
  })

  it('totals each type against the usual count of the earlier months', () => {
    seedDays()
    seedAugustWorkouts()
    const { types } = readActivityPeriod(q(), input(AUGUST))
    expect(types.map((t) => [t.type, t.count])).toEqual([['RUNNING', 3], ['WALKING', 1]])
    const running = types[0]!
    expect(running).toMatchObject({ seconds: 3 * 1800, distanceMeters: 12_000, standing: 'above' })
    // August 2025 began before the days did, so eleven months make the usual, each scaled to August's 31 days.
    expect(running.usualCount).toMatchObject({ periods: 11 })
    expect(running.usualCount!.center).toBeCloseTo(scaledCenter(monthsBefore('2026-08', 11), 2, 31), 9)
    expect(running.usualCount?.window).toMatchObject({ unit: 'month', count: 12, from: '2025-08-01', to: '2026-07-31' })
    expect(types[1]).toMatchObject({ distanceMeters: null, usualCount: { center: 0 } })
  })

  it('leaves the months before any daily data out of the usual count, rather than counting them as none', () => {
    seedDays({ from: '2026-01-01' })
    seedAugustWorkouts(monthsBefore('2026-08', 7))
    // An excluded run in each earlier month does not count towards the usual either.
    for (const month of monthsBefore('2026-08', 7)) seedWorkout(`${month}-12`, 'RUNNING', { excluded: true })
    const running = readActivityPeriod(q(), input(AUGUST)).types[0]!
    expect(running.usualCount).toMatchObject({ periods: 7, thin: true })
    expect(running.usualCount!.center).toBeCloseTo(scaledCenter(monthsBefore('2026-08', 7), 2, 31), 9)
  })

  it('scales each earlier month to the length of the month read: a run every day is the usual in any month', () => {
    seedDays()
    for (const date of datesIn({ from: '2025-09-01', to: '2026-08-31' })) seedWorkout(date, 'RUNNING')
    const running = readActivityPeriod(q(), input(AUGUST)).types[0]!
    expect(running.count).toBe(31)
    expect(running.usualCount!.center).toBeCloseTo(31, 9)
    expect(running.usualCount!.high - running.usualCount!.low).toBeCloseTo(0, 9)
    expect(running.standing).toBe('within')
  })

  it("judges a year against the previous year's quarters at the same rate, not against a quarter's count", () => {
    seedDays({ from: '2024-01-01' })
    for (const date of datesIn({ from: '2024-01-01', to: '2025-12-31' })) {
      if (date.endsWith('-01') || date.endsWith('-15')) seedWorkout(date, 'RUNNING')
    }
    const running = readActivityPeriod(q(), input({ range: 'year', anchor: '2025-06-15' })).types[0]!
    expect(running.count).toBe(24)
    expect(running.usualCount).toMatchObject({ periods: 4, thin: false, window: { unit: 'year', count: 4 } })
    expect(running.usualCount!.center).toBeCloseTo(24, 0)
    expect(running.standing).toBe('within')
  })

  it('orders the types by count, then by type, an untyped workout last among its equals', () => {
    seedDays()
    seedWorkout('2026-08-05', 'YOGA')
    seedWorkout('2026-08-04', 'WALKING')
    seedWorkout('2026-08-03', 'CYCLING')
    seedWorkout('2026-08-06', 'WALKING')
    seedWorkout('2026-08-07', null)
    seedWorkout('2026-08-08', null)
    expect(readActivityPeriod(q(), input(AUGUST)).types.map((t) => t.type)).toEqual(['WALKING', null, 'CYCLING', 'YOGA'])
  })

  it("does not judge the count of a running month against a whole month's usual", () => {
    seedDays()
    for (const month of monthsBefore('2026-09', 12)) {
      seedWorkout(`${month}-05`, 'RUNNING')
      seedWorkout(`${month}-19`, 'RUNNING')
    }
    for (const day of ['01', '03', '05', '07', '09']) seedWorkout(`2026-09-${day}`, 'RUNNING')
    const running = readActivityPeriod(q(), input({ range: 'month', anchor: TODAY })).types[0]!
    expect(running).toMatchObject({ count: 5, usualCount: { thin: false }, standing: null })
    expect(running.usualCount!.center).toBeCloseTo(scaledCenter(monthsBefore('2026-09', 12), 2, 30), 9)
  })

  it('reads the VO2 max trend of the first metric that has one', () => {
    seedDays()
    seedLast('daily_vo2_max', { '2026-04-01': 44, '2026-07-10': 46 })
    seedLast('vo2_max', { '2026-07-10': 30 })
    expect(readActivityPeriod(q(), input(AUGUST)).vo2max).toEqual({
      metric: 'daily_vo2_max', latest: 46, latestDate: '2026-07-10', earlier: 44, earlierDate: '2026-04-01', trend: 'rising',
    })
  })

  it('falls back to vo2_max, and has no trend without a value ninety days earlier', () => {
    seedDays()
    seedLast('vo2_max', { '2026-06-01': 50, '2026-07-10': 49.5 })
    expect(readActivityPeriod(q(), input(AUGUST)).vo2max).toMatchObject({ metric: 'vo2_max', latest: 49.5, earlier: null, trend: null })
  })

  it('calls a drop of one falling, from the last value ninety days before the latest', () => {
    seedDays()
    seedLast('run_vo2_max', { '2026-03-01': 45, '2026-06-01': 44.5, '2026-07-10': 44 })
    expect(readActivityPeriod(q(), input(AUGUST)).vo2max).toMatchObject({ metric: 'run_vo2_max', earlier: 45, trend: 'falling' })
  })

  it('calls a change of less than one steady', () => {
    seedDays()
    seedLast('daily_vo2_max', { '2026-03-01': 45, '2026-07-10': 45.5 })
    expect(readActivityPeriod(q(), input(AUGUST)).vo2max).toMatchObject({ earlier: 45, trend: 'steady' })
  })

  it('calls a rise of one tenth-rounded point rising, though the float difference falls short of one', () => {
    seedDays()
    seedLast('daily_vo2_max', { '2026-03-01': 31.3, '2026-07-10': 32.3 })
    expect(readActivityPeriod(q(), input(AUGUST)).vo2max).toMatchObject({ earlier: 31.3, latest: 32.3, trend: 'rising' })
  })

  it('hides a section without data', () => {
    seedDays()
    seedSeries('active_zone_minutes_fat_burn', () => 5)
    seedSeries('active_zone_minutes_cardio', () => 3)
    const page = readActivityPeriod(q(), input(AUGUST))
    expect(page.heartRateZones).toEqual({ light: null, moderate: null, vigorous: null, peak: null, hard: null })
    expect(page.zoneMinutes.peak).toBeNull()
    expect(page.zoneMinutes.cardio?.value).toBe(3)
    expect(page.cardioLoad).toBeNull()
    expect(page.vo2max).toBeNull()
    expect(page.more.map((f) => f.metric)).toEqual(['active_zone_minutes'])
    expect(page.more[0]).toMatchObject({ value: 8, total: 8 * 31, unit: 'minutes', direction: 'up' })
  })

  it('shows heart rate zones, cardio load and altitude when they have days', () => {
    seedDays()
    seedSeries('time_in_heart_rate_zone_peak_minutes', () => 2)
    seedSeries('cardio_load_edwards', () => 40)
    seedSeries('altitude_gain', () => 12_000)
    const page = readActivityPeriod(q(), input(AUGUST))
    expect(page.heartRateZones.peak?.value).toBe(2)
    expect(page.heartRateZones.light).toBeNull()
    expect(page.cardioLoad).toMatchObject({ value: 40, total: 40 * 31 })
    expect(page.more.map((f) => f.metric)).toEqual(['altitude_gain'])
  })

  it('has no finished day on the Monday of a running week, and still lists that day\'s workouts', () => {
    seedDays()
    const monday = '2026-09-21'
    const id = seedWorkout(monday, 'WALKING')
    const page = readActivityPeriod(q(), input({ range: 'week', anchor: monday, today: monday }))
    expect(page.period.daysSoFar).toBe(0)
    expect(page.hero).toMatchObject({ reason: 'no-data', total: null, days: 0 })
    expect(page.figures).toEqual([])
    expect(page.workouts.map((w) => w.id)).toEqual([id])
  })

  it('reads the workouts of the source asked for', () => {
    seedDays()
    seedWorkout('2026-08-03', 'RUNNING')
    seedWorkout('2026-08-04', 'CYCLING', { sourceId: 'b' })
    const page = readActivityPeriod(q(), input({ ...AUGUST, source: 'b' }))
    expect(page.workouts.map((w) => [w.type, w.sourceId])).toEqual([['CYCLING', 'b']])
  })

  it("sums the vigorous and peak zones a day as the heart-rate card's lead, judged as a figure of its own", () => {
    seedDays()
    seedSeries('time_in_heart_rate_zone_light_minutes', () => 200)
    seedSeries('time_in_heart_rate_zone_vigorous_minutes', () => 8)
    seedSeries('time_in_heart_rate_zone_peak_minutes', (d) => (d === '2026-08-05' ? null : 3))
    const { hard } = readActivityPeriod(q(), input(AUGUST)).heartRateZones
    // A day without peak minutes still counts its vigorous ones; the light zone is not among them.
    expect(hard).toMatchObject({ metric: 'hard_zone_minutes', unit: 'minutes', direction: 'up', per: 'day', days: 31, total: 11 * 31 - 3 })
    expect(hard!.daily.find((d) => d.from === '2026-08-05')!.value).toBe(8)
    expect(hard!.usual).toMatchObject({ periods: 11 })
  })

  it('has no hard-zone lead without vigorous or peak minutes', () => {
    seedDays()
    seedSeries('time_in_heart_rate_zone_light_minutes', () => 200)
    expect(readActivityPeriod(q(), input(AUGUST)).heartRateZones.hard).toBeNull()
  })

  it("reads each day's highest heart rate as a figure judged without a direction", () => {
    seedDays()
    seedSeries('heart_rate', (d) => (Number(d.slice(8, 10)) % 2 === 0 ? 170 : 160), { agg: 'max' })
    seedSeries('heart_rate', () => 70, { agg: 'mean' })
    const page = readActivityPeriod(q(), input(AUGUST))
    expect(page.maxHeartRate).toMatchObject({ metric: 'max_heart_rate', unit: 'bpm', direction: 'neutral', total: null, days: 31 })
    // Fifteen even dates at 170 and sixteen odd at 160, never the mean's 70.
    expect(page.maxHeartRate!.value).toBeCloseTo((15 * 170 + 16 * 160) / 31, 9)
    expect(page.maxHeartRate!.usual).toMatchObject({ periods: 11, thin: false })
  })

  it('has no highest heart rate without one', () => {
    seedDays()
    expect(readActivityPeriod(q(), input(AUGUST)).maxHeartRate).toBeNull()
  })

  it("carries each workout's pace and climb", () => {
    seedDays()
    seedWorkout('2026-08-03', 'RUNNING', { distanceMm: 5_000_000, extra: { averagePaceSecondsPerMeter: 0.318, elevationGainMillimeters: 58_000 } })
    seedWorkout('2026-08-04', 'WALKING')
    const { workouts } = readActivityPeriod(q(), input(AUGUST))
    expect(workouts[1]!.paceSecondsPerKm).toBeCloseTo(318, 9)
    expect(workouts[1]!.elevationGainMeters).toBe(58)
    expect(workouts[0]).toMatchObject({ paceSecondsPerKm: null, elevationGainMeters: null })
  })

  it("carries each workout's rate by its category, a ride's speed and a run's pace worked out from distance and moving time", () => {
    seedDays()
    seedWorkout('2026-08-03', 'BIKING', { distanceMm: 18_000_000 })
    seedWorkout('2026-08-04', 'RUNNING', { distanceMm: 5_000_000 })
    const { workouts } = readActivityPeriod(q(), input(AUGUST))
    expect(workouts[1]!.paceSecondsPerKm).toBeNull()
    expect(workouts[1]!.rate).toEqual({ key: 'speed', unit: 'meters_per_second', value: 10 })
    expect(workouts[0]!.rate).toEqual({ key: 'pace', unit: 'seconds_per_km', value: 360 })
  })

  it("counts each month's workouts and their time, newest first, the excluded ones left out", () => {
    seedDays()
    seedWorkout('2026-07-02', 'RUNNING')
    seedWorkout('2026-08-03', 'RUNNING')
    seedWorkout('2026-08-20', 'WALKING')
    seedWorkout('2026-08-24', 'RUNNING', { excluded: true })
    seedWorkout('2026-09-01', 'RUNNING', { excluded: true })
    const page = readActivityPeriod(q(), input({ range: '3months', anchor: '2026-08-15' }))
    expect(page.workoutMonths).toEqual([{ month: '2026-08', count: 2, seconds: 3600 }, { month: '2026-07', count: 1, seconds: 1800 }])
  })

  it("judges a type's count with more as the better side", () => {
    seedDays()
    seedAugustWorkouts()
    const { types } = readActivityPeriod(q(), input(AUGUST))
    expect(types.map((t) => [t.type, t.standing, t.judged])).toEqual([['RUNNING', 'above', 'better'], ['WALKING', 'above', 'better']])
  })

  it("sends a total's usual as the earlier months' totals, scaled to the month read, and judges the total by it", () => {
    seedDays()
    const distance = readActivityPeriod(q(), input(AUGUST)).figures.find((f) => f.metric === 'distance')!
    // 6 km every day: each earlier month's total, scaled to 31 days, is 31 days of it.
    expect(distance.usualTotal).toMatchObject({ periods: 11, thin: false })
    expect(distance.usualTotal!.center).toBeCloseTo(31 * 6_000_000, 3)
    expect(distance.total).toBe(31 * 6_000_000)
    expect(distance.totalStanding).toBe('within')
  })

  it('reads each metric once and the workouts twice, never a day at a time', () => {
    seedDays()
    seedAugustWorkouts()
    seedLast('daily_vo2_max', { '2026-07-10': 46 })
    const query = q()
    const calls = new Map<string, number>()
    const series = query.series.bind(query)
    query.series = (o) => { calls.set(o.metric, (calls.get(o.metric) ?? 0) + 1); return series(o) }
    let sessionReads = 0
    const readSessions = query.sessions.bind(query)
    query.sessions = (o) => { sessionReads += 1; return readSessions(o) }
    readActivityPeriod(query, input(AUGUST))
    expect(sessionReads).toBe(2)
    for (const [metric, n] of calls) expect([metric, n]).toEqual([metric, 1])
    expect(calls.has('steps')).toBe(true)
    expect(calls.has('vo2_max')).toBe(false)
  })
})

describe('PersonQuery.activityPeriod', () => {
  it('refuses a day range, a period after today, and a merge name as the source', () => {
    expect(() => q().activityPeriod(input({ range: 'day' as never, anchor: '2026-08-15' }))).toThrow(/range/)
    expect(() => q().activityPeriod(input({ range: 'month', anchor: '2026-10-02' }))).toThrow(/after today/)
    const query = q()
    let reads = 0
    const series = query.series.bind(query)
    query.series = (o) => { reads += 1; return series(o) }
    expect(() => query.activityPeriod(input({ ...AUGUST, source: 'merged' }))).toThrow(/merged/)
    expect(reads).toBe(0)
    expect(q().activityPeriod(input(AUGUST)).period.from).toBe(periodBounds('month', '2026-08-15').from)
  })
})
