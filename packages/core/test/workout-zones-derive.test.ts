import { afterEach, describe, expect, test } from 'vitest'
import { and, eq, like } from 'drizzle-orm'
import { deriveDayInto } from '../src/derive/deriveDay.ts'
import type { DeriveDayInput } from '../src/derive/deriveDay.ts'
import { daily, sessions, sources } from '../src/db/schema/index.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import { DEFAULT_NIGHT_GAP_MINUTES } from '../src/derive/sleep.ts'
import { DEFAULT_OVERLAP_RATIO } from '../src/derive/sessionOverlap.ts'
import { MERGED_SOURCE } from '../src/derive/rollup.ts'
import { edwardsLoad } from '../src/api/cardioLoad.ts'
import { INTRADAY_WINDOW_MAX_MS } from '../src/query/intraday.ts'
import type { OverrideLike } from '../src/derive/overrides.ts'
import { dayMetricTarget, sessionTarget } from '../src/derive/targetKey.ts'
import { createTestDatabase, insertSample, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

let t: TestDatabase
afterEach(() => { t.cleanup() })

const PERSON = 'p1'
const DATE = '2026-09-20'
const MINUTE = 60_000
const START = Date.parse(`${DATE}T07:00:00Z`)
// Born 1986-01-01, so 40 on the day: a Tanaka maximum of 180, and against a resting heart rate of
// 60 a reserve of 120, putting the zones at moderate 108, vigorous 132 and peak 162. One minute in
// each zone, light included.
const BIRTHDAY = '1986-01-01'
const ONE_MINUTE_EACH = [100, 120, 140, 170]

const zoneMetric = (zone: string) => `time_in_heart_rate_zone_${zone}_minutes`

const seed = (sourceIds: string[]): TestDatabase['db'] => {
  t = createTestDatabase()
  seedPerson(t.db, PERSON)
  for (const id of sourceIds) {
    t.db.insert(sources).values({ id, personId: PERSON, externalId: id, displayName: id, kind: 'app', createdAtMs: 0 }).run()
  }
  return t.db
}

const seedWorkout = (db: TestDatabase['db'], id: string, sourceId: string, bpms: number[] | null, offsetMs = 0) => {
  const startMs = START + offsetMs
  db.insert(sessions).values({
    id, personId: PERSON, sourceId, kind: 'exercise', externalId: id,
    startMs, startOffsetMinutes: 0, endMs: startMs + ONE_MINUTE_EACH.length * MINUTE, endOffsetMinutes: 0,
    localDate: DATE, attrs: '{}', rawPayloadId: null,
  }).run()
  for (const [at, bpm] of (bpms ?? []).entries()) {
    insertSample(db, { personId: PERSON, sourceId, metric: 'heart_rate', utcMs: startMs + at * MINUTE, value: bpm })
  }
}

const seedDayValue = (db: TestDatabase['db'], sourceId: string, metric: string, value: number) => {
  insertSample(db, { personId: PERSON, sourceId, metric, utcMs: Date.parse(`${DATE}T05:00:00Z`), value })
}

const derive = (db: TestDatabase['db'], input: Partial<DeriveDayInput> = {}) =>
  db.transaction((tx) => deriveDayInto(tx, {
    personId: PERSON,
    localDate: DATE,
    birthDate: BIRTHDAY,
    priority: priorityFrom({ lists: new Map(), sources: [] }),
    overrides: [],
    gapMinutes: DEFAULT_NIGHT_GAP_MINUTES,
    overlapRatio: DEFAULT_OVERLAP_RATIO,
    nowMs: 1,
    ...input,
  }))

const zoneRows = (db: TestDatabase['db'], source?: string) => db.select().from(daily).where(and(
  eq(daily.personId, PERSON),
  eq(daily.localDate, DATE),
  like(daily.metric, 'time_in_heart_rate_zone_%'),
  source === undefined ? undefined : eq(daily.source, source),
)).all()

/** One source's zone minutes as { light, moderate, vigorous, peak }, absent zones left out. */
const zonesOf = (db: TestDatabase['db'], source: string) => Object.fromEntries(
  zoneRows(db, source).map((row) => [row.metric.replace('time_in_heart_rate_zone_', '').replace('_minutes', ''), row.value]),
)

const exclude = (scope: OverrideLike['scope'], targetKey: string): OverrideLike =>
  ({ scope, targetKey, action: 'exclude', correctedValue: null })

describe('daily heart rate zone minutes from workouts', () => {
  test('writes zone minutes from the formula for a phone workout', () => {
    const db = seed(['phone'])
    seedWorkout(db, 'run', 'phone', ONE_MINUTE_EACH)
    seedDayValue(db, 'phone', 'resting_heart_rate', 60)

    derive(db)

    const oneEach = { light: 1, moderate: 1, vigorous: 1, peak: 1 }
    expect(zonesOf(db, 'phone')).toEqual(oneEach)
    expect(zonesOf(db, MERGED_SOURCE)).toEqual(oneEach)
    const rows = zoneRows(db)
    expect(rows).toHaveLength(8)
    for (const row of rows) {
      expect(row.basis).toBe('zone_formula')
      expect(row.agg).toBe('sum')
      expect(row.coverage).toBeNull()
      expect(row.sourceMix).toBeNull()
    }

    const load = db.select().from(daily).where(and(
      eq(daily.personId, PERSON), eq(daily.metric, 'cardio_load_edwards'), eq(daily.source, MERGED_SOURCE),
    )).get()
    expect(load?.value).toBe(edwardsLoad({ lightMinutes: 1, moderateMinutes: 1, vigorousMinutes: 1, peakMinutes: 1 }))
    expect(load?.basis).toBe('zone_formula')
  })

  test('writes nothing on a day with Google\'s ceilings', () => {
    const db = seed(['phone'])
    seedWorkout(db, 'run', 'phone', ONE_MINUTE_EACH)
    seedDayValue(db, 'phone', 'resting_heart_rate', 60)
    seedDayValue(db, 'phone', 'heart_rate_zone_light_max_bpm', 150)
    seedDayValue(db, 'phone', 'heart_rate_zone_moderate_max_bpm', 160)
    seedDayValue(db, 'phone', 'heart_rate_zone_vigorous_max_bpm', 165)
    seedDayValue(db, 'phone', 'heart_rate_zone_peak_max_bpm', 190)

    derive(db)

    expect(zoneRows(db)).toEqual([])
    expect(db.select().from(daily).where(eq(daily.metric, 'cardio_load_edwards')).all()).toEqual([])
  })

  test('writes nothing on a day with only some of Google\'s ceilings', () => {
    const db = seed(['phone'])
    seedWorkout(db, 'run', 'phone', ONE_MINUTE_EACH)
    seedDayValue(db, 'phone', 'resting_heart_rate', 60)
    seedDayValue(db, 'phone', 'heart_rate_zone_light_max_bpm', 150)

    derive(db)

    expect(zoneRows(db)).toEqual([])
  })

  test('writes nothing for any target when another source reported zone minutes that day', () => {
    const db = seed(['phone', 'watch'])
    seedWorkout(db, 'run', 'phone', ONE_MINUTE_EACH)
    seedDayValue(db, 'phone', 'resting_heart_rate', 60)
    seedDayValue(db, 'watch', zoneMetric('light'), 30)
    seedDayValue(db, 'watch', zoneMetric('moderate'), 12)

    derive(db)

    expect(zoneRows(db, 'phone')).toEqual([])
    expect(zonesOf(db, MERGED_SOURCE)).toEqual({ light: 30, moderate: 12 })
    expect(zoneRows(db).some((row) => row.basis === 'zone_formula')).toBe(false)
  })

  test('leaves a day with Google\'s zone minutes alone', () => {
    const db = seed(['google', 'phone'])
    seedWorkout(db, 'run', 'phone', ONE_MINUTE_EACH)
    seedDayValue(db, 'phone', 'resting_heart_rate', 60)
    seedDayValue(db, 'google', zoneMetric('light'), 30)

    derive(db)

    const merged = zoneRows(db, MERGED_SOURCE)
    expect(merged.map((row) => [row.metric, row.value])).toEqual([[zoneMetric('light'), 30]])
    expect(merged.some((row) => row.basis === 'zone_formula')).toBe(false)
    expect(zonesOf(db, 'google')).toEqual({ light: 30 })
  })

  test('writes nothing without a birthday', () => {
    const db = seed(['phone'])
    seedWorkout(db, 'run', 'phone', ONE_MINUTE_EACH)
    seedDayValue(db, 'phone', 'resting_heart_rate', 60)

    derive(db, { birthDate: null })

    expect(zoneRows(db)).toEqual([])
  })

  test('writes nothing for a workout without heart rate', () => {
    const db = seed(['phone'])
    seedWorkout(db, 'run', 'phone', null)
    seedDayValue(db, 'phone', 'resting_heart_rate', 60)

    derive(db)

    expect(zoneRows(db)).toEqual([])
    // A zero load would read as a rest day measured, when nothing was measured at all.
    expect(db.select().from(daily).where(eq(daily.metric, 'cardio_load_edwards')).all()).toEqual([])
  })

  test('skips a session longer than the intraday window', () => {
    const db = seed(['phone'])
    db.insert(sessions).values({
      id: 'stuck', personId: PERSON, sourceId: 'phone', kind: 'exercise', externalId: 'stuck',
      startMs: START, startOffsetMinutes: 0, endMs: START + INTRADAY_WINDOW_MAX_MS + MINUTE, endOffsetMinutes: 0,
      localDate: DATE, attrs: '{}', rawPayloadId: null,
    }).run()
    for (const [at, bpm] of ONE_MINUTE_EACH.entries()) {
      insertSample(db, { personId: PERSON, sourceId: 'phone', metric: 'heart_rate', utcMs: START + at * MINUTE, value: bpm })
    }
    seedDayValue(db, 'phone', 'resting_heart_rate', 60)

    derive(db)

    expect(zoneRows(db)).toEqual([])
  })

  test('counts a workout recorded by watch and phone once in the merged view', () => {
    const db = seed(['phone', 'watch'])
    seedWorkout(db, 'phone-run', 'phone', ONE_MINUTE_EACH)
    seedWorkout(db, 'watch-run', 'watch', ONE_MINUTE_EACH)
    seedDayValue(db, 'phone', 'resting_heart_rate', 60)

    derive(db)

    const oneEach = { light: 1, moderate: 1, vigorous: 1, peak: 1 }
    expect(zonesOf(db, 'phone')).toEqual(oneEach)
    expect(zonesOf(db, 'watch')).toEqual(oneEach)
    expect(zonesOf(db, MERGED_SOURCE)).toEqual(oneEach)
  })

  test('skips an excluded workout, and a day_metric exclusion removes the row', () => {
    const db = seed(['phone'])
    seedWorkout(db, 'run', 'phone', ONE_MINUTE_EACH)
    seedDayValue(db, 'phone', 'resting_heart_rate', 60)

    derive(db, { overrides: [exclude('session', sessionTarget('run'))] })
    expect(zoneRows(db)).toEqual([])

    derive(db, { overrides: [exclude('day_metric', dayMetricTarget({ localDate: DATE, metric: zoneMetric('light') }))] })
    expect(zonesOf(db, MERGED_SOURCE)).toEqual({ moderate: 1, vigorous: 1, peak: 1 })
    expect(zonesOf(db, 'phone')).toEqual({ moderate: 1, vigorous: 1, peak: 1 })
  })

  test('stops writing formula rows once the birthday is cleared', () => {
    const db = seed(['phone'])
    seedWorkout(db, 'run', 'phone', ONE_MINUTE_EACH)
    seedDayValue(db, 'phone', 'resting_heart_rate', 60)

    derive(db)
    expect(zoneRows(db)).toHaveLength(8)

    derive(db, { birthDate: null })
    expect(zoneRows(db)).toEqual([])
    expect(db.select().from(daily).where(eq(daily.metric, 'cardio_load_edwards')).all()).toEqual([])
  })

  test('takes no bounds from a resting heart rate the person excluded', () => {
    const db = seed(['phone'])
    seedWorkout(db, 'run', 'phone', ONE_MINUTE_EACH)
    seedDayValue(db, 'phone', 'resting_heart_rate', 60)

    derive(db, { overrides: [exclude('day_metric', dayMetricTarget({ localDate: DATE, metric: 'resting_heart_rate' }))] })

    expect(zoneRows(db)).toEqual([])
  })
})
