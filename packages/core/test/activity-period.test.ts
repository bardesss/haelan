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
import { datesIn, periodBounds } from '../src/query/periodBounds.ts'

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

function seedSeries(metric: string, value: (date: string) => number | null, o: { from?: string, to?: string } = {}) {
  const rows = datesIn({ from: o.from ?? FIRST, to: o.to ?? TODAY }).flatMap((localDate) => {
    const v = value(localDate)
    return v === null ? [] : [{
      personId: 'p1', localDate, metric, agg: 'sum', source: 'merged', value: v, coverage: 1,
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

function seedWorkout(localDate: string, type: string | null, o: { sourceId?: string, hour?: string, distanceMm?: number, excluded?: boolean } = {}) {
  const sourceId = o.sourceId ?? 'watch'
  const id = `${sourceId}-${type ?? 'untyped'}-${localDate}-${o.hour ?? '07'}`
  const startMs = Date.parse(`${localDate}T${o.hour ?? '07'}:00:00Z`) - OFFSET * 60_000
  test.db.insert(sessions).values({
    id, personId: 'p1', sourceId, kind: 'exercise', externalId: id,
    startMs, startOffsetMinutes: OFFSET, endMs: startMs + 40 * 60_000, endOffsetMinutes: OFFSET, localDate, rawPayloadId: null,
    attrs: JSON.stringify(attrsOf({
      exerciseType: type, activeDuration: '1800s',
      metricsSummary: o.distanceMm === undefined ? { caloriesKcal: 300 } : { caloriesKcal: 300, distanceMillimeters: o.distanceMm },
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
    // August 2025 began before the days did, so eleven months make the usual.
    expect(running.usualCount).toMatchObject({ center: 2, periods: 11 })
    expect(running.usualCount?.window).toMatchObject({ unit: 'month', count: 12, from: '2025-08-01', to: '2026-07-31' })
    expect(types[1]).toMatchObject({ distanceMeters: null, usualCount: { center: 0 } })
  })

  it('leaves the months before any daily data out of the usual count, rather than counting them as none', () => {
    seedDays({ from: '2026-01-01' })
    seedAugustWorkouts(monthsBefore('2026-08', 7))
    // An excluded run in each earlier month does not count towards the usual either.
    for (const month of monthsBefore('2026-08', 7)) seedWorkout(`${month}-12`, 'RUNNING', { excluded: true })
    const running = readActivityPeriod(q(), input(AUGUST)).types[0]!
    expect(running.usualCount).toMatchObject({ center: 2, periods: 7, thin: true })
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
    expect(running).toMatchObject({ count: 5, usualCount: { center: 2, thin: false }, standing: null })
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

  it('hides a section without data', () => {
    seedDays()
    seedSeries('active_zone_minutes_fat_burn', () => 5)
    seedSeries('active_zone_minutes_cardio', () => 3)
    const page = readActivityPeriod(q(), input(AUGUST))
    expect(page.heartRateZones).toEqual({ light: null, moderate: null, vigorous: null, peak: null })
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
