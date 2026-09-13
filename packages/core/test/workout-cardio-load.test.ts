import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, insertSample } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readWorkoutCardioLoad } from '../src/query/workoutDerived.ts'
import { readSession } from '../src/query/sessions.ts'
import type { WorkoutSession } from '../src/query/sessions.ts'
import { PeopleStore } from '../src/store/people.ts'
import { sessions, sources, daily } from '../src/db/schema/index.ts'
import { MERGED_SOURCE, PROVIDER_SOURCE } from '../src/derive/rollup.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'

// The session on 2026-09-12, which is also the date the "falls back to 220 minus age" case needs:
// a person born 1985-03-04 turns 41 that day, and 220 - 41 = 179.
const LOCAL_DATE = '2026-09-12'
const OFFSET = 120
const START_MS = Date.UTC(2026, 8, 12, 6, 0)
const SESSION_MINUTES = 80
const END_MS = START_MS + SESSION_MINUTES * 60_000

const FULL_ZONE_ATTRS = {
  metricsSummary: {
    // 600s each -> 10 minutes each -> Edwards = 1*10 + 2*10 + 3*10 + 4*10 = 100.
    heartRateZoneDurations: {
      lightTime: '600s', moderateTime: '600s', vigorousTime: '600s', peakTime: '600s',
    },
  },
}

let t: TestDatabase
beforeEach(() => { t = createTestDatabase() })
afterEach(() => t.cleanup())

/** One person and the device that recorded their workout. */
function seedPersonAndSource(): void {
  seedPerson(t.db, 'p1')
  t.db.insert(sources).values({
    id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).run()
}

/** The workout itself, with whatever attrs the case is testing. Follows query-session-by-id's
 *  own `insert` helper for seeding a session with a real span rather than seedSession's zero one. */
function seedWorkout(attrs: unknown): WorkoutSession {
  t.db.insert(sessions).values({
    id: 'w1', personId: 'p1', sourceId: 'watch', kind: 'exercise', externalId: 'w1',
    startMs: START_MS, startOffsetMinutes: OFFSET, endMs: END_MS, endOffsetMinutes: OFFSET,
    localDate: LOCAL_DATE, attrs: JSON.stringify(attrs), rawPayloadId: null,
  }).run()
  return readSession(t.db, { personId: 'p1', sessionId: 'w1' })!
}

/** Heart rate across the whole session span, one reading a minute rising from 100 to 179 bpm,
 *  three rows per minute (min, mean, max) because heart_rate is stored downsampled to the
 *  minute - the same pattern intraday-window.test.ts seeds. */
function seedHeartRate(): void {
  for (let i = 0; i < SESSION_MINUTES; i += 1) {
    for (const agg of ['min', 'mean', 'max'] as const) {
      insertSample(t.db, {
        personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
        utcMs: START_MS + i * 60_000, tzOffsetMinutes: OFFSET, agg, value: 100 + i,
      })
    }
  }
}

function seedDaily(metric: string, value: number, source: string): void {
  t.db.insert(daily).values({
    personId: 'p1', localDate: LOCAL_DATE, metric, agg: 'last', source, value,
    coverage: null, sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
  }).run()
}

describe('a workout cardio load', () => {
  it('computes Edwards from the session zone clocks', () => {
    seedPersonAndSource()
    const session = seedWorkout(FULL_ZONE_ATTRS)

    const load = readWorkoutCardioLoad(t.db, { personId: 'p1', session })!
    expect(load.edwards).toBe(100)
  })

  it('computes Banister from the session heart rate, resting HR and the peak zone ceiling', () => {
    seedPersonAndSource()
    const session = seedWorkout(FULL_ZONE_ATTRS)
    seedHeartRate()
    new PeopleStore(t.db).setBirthDate('p1', '1985-03-04')
    new PeopleStore(t.db).setSex('p1', 'male')
    // The provider's own reconciled row, which is where a resting heart rate usually lives for a
    // household that has only ever had one device.
    seedDaily('resting_heart_rate', 52, PROVIDER_SOURCE)
    seedDaily('heart_rate_zone_peak_max_bpm', 185, PROVIDER_SOURCE)

    const load = readWorkoutCardioLoad(t.db, { personId: 'p1', session })!
    expect(load.banister).toBeGreaterThan(0)
    expect(load.banisterBasis).toEqual({
      restingBpm: 52,
      maxBpm: 185,
      maxBpmSource: 'providerZoneCeiling',
      k: 1.92,
      minutes: 80,
    })
  })

  it('falls back to 220 minus age when the day has no peak zone ceiling', () => {
    seedPersonAndSource()
    const session = seedWorkout(FULL_ZONE_ATTRS)
    seedHeartRate()
    new PeopleStore(t.db).setBirthDate('p1', '1985-03-04')
    new PeopleStore(t.db).setSex('p1', 'male')
    seedDaily('resting_heart_rate', 52, MERGED_SOURCE)
    // No heart_rate_zone_peak_max_bpm row at all for this day.

    const load = readWorkoutCardioLoad(t.db, { personId: 'p1', session })!
    expect(load.banisterBasis?.maxBpm).toBe(179)
    expect(load.banisterBasis?.maxBpmSource).toBe('ageFormula')
  })

  it('uses 1.67 for a female profile', () => {
    seedPersonAndSource()
    const session = seedWorkout(FULL_ZONE_ATTRS)
    seedHeartRate()
    new PeopleStore(t.db).setBirthDate('p1', '1985-03-04')
    new PeopleStore(t.db).setSex('p1', 'female')
    seedDaily('resting_heart_rate', 52, MERGED_SOURCE)
    seedDaily('heart_rate_zone_peak_max_bpm', 185, MERGED_SOURCE)

    expect(readWorkoutCardioLoad(t.db, { personId: 'p1', session })!.banisterBasis?.k).toBe(1.67)
  })

  // Null rather than a number standing on a guess. Each of these is a separate reason.
  it('answers no Banister without a birthday and a sex', () => {
    seedPersonAndSource()
    const session = seedWorkout(FULL_ZONE_ATTRS)
    seedHeartRate()
    seedDaily('resting_heart_rate', 52, MERGED_SOURCE)
    seedDaily('heart_rate_zone_peak_max_bpm', 185, MERGED_SOURCE)
    // No setBirthDate, no setSex: the profile stays null, null from seedPerson.

    const load = readWorkoutCardioLoad(t.db, { personId: 'p1', session })!
    expect(load.banister).toBeNull()
    expect(load.banisterBasis).toBeNull()
    // Edwards needs neither, so it still answers.
    expect(load.edwards).toBe(100)
  })

  // Both, not either. The case above leaves both fields null, which an `&&` guard would refuse
  // exactly as an `||` guard does - it proves nothing about which operator is written. Only a
  // profile with one field set and the other missing tells the two apart.
  it('answers no Banister with a birthday but no sex', () => {
    seedPersonAndSource()
    const session = seedWorkout(FULL_ZONE_ATTRS)
    seedHeartRate()
    seedDaily('resting_heart_rate', 52, MERGED_SOURCE)
    seedDaily('heart_rate_zone_peak_max_bpm', 185, MERGED_SOURCE)
    new PeopleStore(t.db).setBirthDate('p1', '1985-03-04')
    // No setSex: k has nothing to come from, so a load computed anyway would be a number nobody
    // can account for.

    const load = readWorkoutCardioLoad(t.db, { personId: 'p1', session })!
    expect(load.banister).toBeNull()
    expect(load.banisterBasis).toBeNull()
    expect(load.edwards).toBe(100)
  })

  // The mirror of the case above: sex alone is just as insufficient, because the 220 - age
  // fallback still needs a birthday even when the zone ceiling is missing too.
  it('answers no Banister with a sex but no birthday', () => {
    seedPersonAndSource()
    const session = seedWorkout(FULL_ZONE_ATTRS)
    seedHeartRate()
    seedDaily('resting_heart_rate', 52, MERGED_SOURCE)
    seedDaily('heart_rate_zone_peak_max_bpm', 185, MERGED_SOURCE)
    new PeopleStore(t.db).setSex('p1', 'male')
    // No setBirthDate: no age to compute and no k to withhold it for.

    const load = readWorkoutCardioLoad(t.db, { personId: 'p1', session })!
    expect(load.banister).toBeNull()
    expect(load.banisterBasis).toBeNull()
    expect(load.edwards).toBe(100)
  })

  it('answers no Banister without a resting heart rate for the day', () => {
    seedPersonAndSource()
    const session = seedWorkout(FULL_ZONE_ATTRS)
    seedHeartRate()
    new PeopleStore(t.db).setBirthDate('p1', '1985-03-04')
    new PeopleStore(t.db).setSex('p1', 'male')
    seedDaily('heart_rate_zone_peak_max_bpm', 185, MERGED_SOURCE)
    // No resting_heart_rate row for this day.

    const load = readWorkoutCardioLoad(t.db, { personId: 'p1', session })!
    expect(load.banister).toBeNull()
    expect(load.edwards).toBe(100)
  })

  it('answers no Banister when nobody recorded a heart rate in the span', () => {
    seedPersonAndSource()
    const session = seedWorkout(FULL_ZONE_ATTRS)
    // No seedHeartRate() call: the profile and the daily rows are all present, but the span has
    // no samples in it at all.
    new PeopleStore(t.db).setBirthDate('p1', '1985-03-04')
    new PeopleStore(t.db).setSex('p1', 'male')
    seedDaily('resting_heart_rate', 52, MERGED_SOURCE)
    seedDaily('heart_rate_zone_peak_max_bpm', 185, MERGED_SOURCE)

    const load = readWorkoutCardioLoad(t.db, { personId: 'p1', session })!
    expect(load.banister).toBeNull()
    expect(load.edwards).toBe(100)
  })

  // An object of three nulls is not a thin answer, it is an absent one - the same rule
  // api/workoutSummary.ts's nullIfAllNull applies to every fixed-member shape it builds.
  it('answers null outright when neither model could run', () => {
    seedPersonAndSource()
    // No zones at all, and no profile: Edwards has nothing to sum and Banister has no birthday
    // or sex to run against.
    const sessionWithNoZones = seedWorkout({})

    expect(readWorkoutCardioLoad(t.db, { personId: 'p1', session: sessionWithNoZones })).toBeNull()
  })

  it('answers Edwards alone for a session with zones and no heart rate profile', () => {
    seedPersonAndSource()
    const session = seedWorkout(FULL_ZONE_ATTRS)
    seedHeartRate()
    seedDaily('resting_heart_rate', 52, MERGED_SOURCE)
    seedDaily('heart_rate_zone_peak_max_bpm', 185, MERGED_SOURCE)
    // No setBirthDate, no setSex.

    const load = readWorkoutCardioLoad(t.db, { personId: 'p1', session })!
    expect(load).toEqual({ edwards: 100, banister: null, banisterBasis: null })
  })
})
