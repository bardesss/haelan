import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, insertSample, seedOverride } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sources, sessions, sessionSegments } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { shiftLocalDate } from '../src/derive/localDay.ts'
import { sessionTarget } from '../src/derive/targetKey.ts'
import { PeopleStore } from '../src/store/people.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { readWorkoutPage, splitTrendOf } from '../src/query/workoutPage.ts'
import { compareWorkout } from '../src/api/workoutComparison.ts'

const TODAY = '2026-09-10'
const SUBJECT_DATE = '2026-09-04'
// Local time is UTC+2 throughout, so a local clock time is two hours ahead of its instant.
const OFFSET = 120

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({ id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
})
afterEach(() => test.cleanup())

const q = () => new PersonQuery(test.db, 'p1')
const input = (sessionId: string) => ({ sessionId, today: TODAY, nowMs: Date.parse('2026-09-10T10:00:00Z'), nameOf: (id: string) => id })

/** The instant of a local clock time on a local date, under OFFSET. */
const at = (localDate: string, hhmm: string) => Date.parse(`${localDate}T${hhmm}:00Z`) - OFFSET * 60_000

interface WorkoutValues {
  /** Seconds per kilometre, stored as the provider's seconds per metre. */
  pace?: number
  /** Metres, stored as the provider's millimetres. */
  distance?: number
  /** One-kilometre automatic splits, each its active seconds. */
  splits?: { distance: number, seconds: number }[]
  /** Moving time in seconds, stored as the provider's protobuf Duration string. */
  moving?: number
  /** Any further metricsSummary fields, as the provider stores them. */
  metrics?: Record<string, unknown>
}

interface WorkoutOptions { excluded?: boolean, hhmm?: string, minutes?: number }

/**
 * One exercise session with attrs in the shape mapSessions stores: all fifteen keys present, null
 * where the payload did not carry the field, the provider's own units and JSON types inside
 * metricsSummary, and splits in the provider's split shape (its own nested metricsSummary).
 */
function seedWorkout(id: string, localDate: string, exerciseType: string, v: WorkoutValues, o: WorkoutOptions = {}) {
  const startMs = at(localDate, o.hhmm ?? '07:00')
  const endMs = startMs + (o.minutes ?? 30) * 60_000
  const metricsSummary = {
    ...(v.pace === undefined ? {} : { averagePaceSecondsPerMeter: v.pace / 1000 }),
    ...(v.distance === undefined ? {} : { distanceMillimeters: v.distance * 1000 }),
    ...v.metrics,
  }
  let splitStart = startMs
  const splits = v.splits?.map((s) => {
    const split = {
      startTime: new Date(splitStart).toISOString(), endTime: new Date(splitStart + s.seconds * 1000).toISOString(),
      splitType: 'DISTANCE', activeDuration: `${s.seconds}s`,
      metricsSummary: { distanceMillimeters: s.distance * 1000, averagePaceSecondsPerMeter: s.seconds / s.distance },
    }
    splitStart += s.seconds * 1000
    return split
  })
  test.db.insert(sessions).values({
    id, personId: 'p1', sourceId: 'watch', kind: 'exercise', externalId: id,
    startMs, startOffsetMinutes: OFFSET, endMs, endOffsetMinutes: OFFSET, localDate, rawPayloadId: null,
    attrs: JSON.stringify({
      type: null, mainSleep: null, stagesStatus: null, summary: null, shortAwakenings: null,
      splitSummaries: null, exerciseEvents: null, displayName: null, notes: null, routeConsentRequired: null,
      exerciseMetadata: { hasGps: false },
      exerciseType, metricsSummary, splits: splits ?? null,
      activeDuration: v.moving === undefined ? null : `${v.moving}s`,
    }),
  }).run()
  if (o.excluded === true) seedOverride(test.db, { personId: 'p1', scope: 'session', targetKey: sessionTarget(id), action: 'exclude' })
}

const seedRun = (id: string, localDate: string, v: WorkoutValues, o?: WorkoutOptions) => seedWorkout(id, localDate, 'RUNNING', v, o)
const seedRide = (id: string, localDate: string, v: WorkoutValues, o?: WorkoutOptions) => seedWorkout(id, localDate, 'BIKING', v, o)

/** `n` runs every third day up to the day before SUBJECT_DATE, pace jittered five seconds either way on alternate runs. */
function seedRuns(n: number, v: { pace: number }) {
  for (let i = 0; i < n; i += 1) {
    const jitter = i % 2 === 0 ? 5 : -5
    seedRun(`run-${i}`, shiftLocalDate(SUBJECT_DATE, -3 * (n - i)), { pace: v.pace + jitter })
  }
}

function seedDaily(localDate: string, metric: string, agg: string, value: number) {
  test.db.insert(daily).values({
    personId: 'p1', localDate, metric, agg, source: 'merged', value, coverage: 1, sourceMix: null,
    derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
  }).run()
}

/** One main sleep session filed under `localDate` with one segment, as the night page's tests seed one. */
function seedNight(localDate: string, v: { asleep?: number, deep?: number }) {
  const id = `night-${localDate}`
  const startMs = at(shiftLocalDate(localDate, -1), '23:00')
  const endMs = at(localDate, '07:00')
  test.db.insert(sessions).values({
    id, personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: id,
    startMs, startOffsetMinutes: OFFSET, endMs, endOffsetMinutes: OFFSET, localDate, rawPayloadId: null,
    attrs: JSON.stringify({ type: null, mainSleep: true, stagesStatus: 'SUCCEEDED', summary: { minutesInSleepPeriod: '480' } }),
  }).run()
  test.db.insert(sessionSegments).values({ id: `${id}-1`, sessionId: id, stage: 'light', startMs, endMs }).run()
  seedDaily(localDate, 'sleep_asleep_minutes', 'sum', v.asleep ?? 420)
  if (v.deep !== undefined) seedDaily(localDate, 'sleep_deep_minutes', 'sum', v.deep)
}

/** Heart rate one reading a minute from `fromMs`, stored downsampled to the minute as min, mean and max rows. */
function seedHeartRate(fromMs: number, bpms: readonly number[]) {
  bpms.forEach((bpm, i) => {
    for (const agg of ['min', 'mean', 'max'] as const) {
      insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: fromMs + i * 60_000, tzOffsetMinutes: OFFSET, agg, value: bpm })
    }
  })
}

describe('readWorkoutPage', () => {
  it('is null for an unknown session', () => {
    expect(readWorkoutPage(q(), input('nope'))).toBeNull()
  })

  it('is null for a sleep session', () => {
    seedNight(SUBJECT_DATE, {})
    expect(readWorkoutPage(q(), input(`night-${SUBJECT_DATE}`))).toBeNull()
  })

  it('judges pace against the earlier runs, lower being better, with a ten-run strip', () => {
    seedRuns(12, { pace: 330 })
    seedRun('subject', SUBJECT_DATE, { pace: 300, distance: 5200 })
    const page = readWorkoutPage(q(), input('subject'))!
    expect(page.hero).toBe('pace')
    expect(page.figures.pace).toMatchObject({ key: 'pace', standing: 'below', judged: 'better', direction: 'down' })
    expect(page.figures.pace!.baseline).toMatchObject({ thin: false })
    expect(page.figures.pace!.baseline!.center).toBeCloseTo(330)
    const strip = page.figures.pace!.strip
    expect(strip).toHaveLength(10)
    // Oldest first: the ninth-latest earlier run through the latest, then this one.
    expect(strip.map((p) => p.sessionId)).toEqual(['run-3', 'run-4', 'run-5', 'run-6', 'run-7', 'run-8', 'run-9', 'run-10', 'run-11', 'subject'])
    expect(strip.at(-1)).toEqual({ sessionId: 'subject', localDate: SUBJECT_DATE, value: 300, standing: 'below', judged: 'better' })
  })

  it('judges every strip point against the figure\'s own usual, so each dot takes its verdict\'s tone', () => {
    seedRuns(12, { pace: 330 })
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    const strip = readWorkoutPage(q(), input('subject'))!.figures.pace!.strip
    // The earlier runs at 325 and 335 sit inside the band they make; the subject is below it, and
    // a lower pace is the better one.
    expect(strip.slice(0, -1).every((p) => p.standing === 'within' && p.judged === null)).toBe(true)
    expect(strip.at(-1)).toMatchObject({ standing: 'below', judged: 'better' })
  })

  it('claims no standing on a strip point while the usual is thin', () => {
    seedRuns(4, { pace: 330 })
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    const strip = readWorkoutPage(q(), input('subject'))!.figures.pace!.strip
    expect(strip.map((p) => [p.standing, p.judged])).toEqual(strip.map(() => [null, null]))
  })

  it('leaves an excluded run out of the usual range and the strip', () => {
    // Six earlier runs at 325 and 335 and, between them, an excluded one at a pace no run of this
    // person's comes near: counted, it would drag the usual far below 330 and widen it past 300.
    seedRuns(6, { pace: 330 })
    seedRun('excluded', shiftLocalDate(SUBJECT_DATE, -1), { pace: 100 }, { excluded: true })
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    const pace = readWorkoutPage(q(), input('subject'))!.figures.pace!
    expect(pace.baseline!.center).toBeCloseTo(330)
    expect(pace.standing).toBe('below')
    expect(pace.strip.map((p) => p.sessionId)).not.toContain('excluded')
  })

  it('claims no standing below five earlier sessions of the type', () => {
    seedRuns(4, { pace: 330 })
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    const pace = readWorkoutPage(q(), input('subject'))!.figures.pace!
    expect(pace.standing).toBeNull()
    expect(pace.baseline!.thin).toBe(true)
  })

  it('picks the previous run of the same type, however long ago, and skips an excluded one', () => {
    seedRun('first', '2026-01-10', { pace: 340, distance: 5000 })
    seedRun('skipped', '2026-08-01', { pace: 320 }, { excluded: true })
    seedRide('ride', '2026-09-01', {})
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    expect(readWorkoutPage(q(), input('subject'))!.previous).toEqual({
      sessionId: 'first', localDate: '2026-01-10', values: { pace: 340, distance: 5000, elapsed: 1800 },
    })
  })

  // A time hero leads the comparison table with its own row, so the previous session's moving and
  // elapsed times travel with its other values.
  it("sends the previous session's moving and elapsed times, for a time hero's row", () => {
    seedWorkout('before', '2026-09-01', 'WEIGHTLIFTING', { moving: 2400 }, { minutes: 45 })
    seedWorkout('subject', SUBJECT_DATE, 'WEIGHTLIFTING', { moving: 2500 }, { minutes: 50 })
    expect(readWorkoutPage(q(), input('subject'))!.previous!.values).toEqual({ movingTime: 2400, elapsed: 2700 })
  })

  it('sends the previous ride\'s speed, so a speed hero\'s table has its row', () => {
    seedRide('before', '2026-09-01', { distance: 20_000, metrics: { averageSpeedMillimetersPerSecond: 6500 } })
    seedRide('subject', SUBJECT_DATE, { distance: 21_000, metrics: { averageSpeedMillimetersPerSecond: 7000 } })
    expect(readWorkoutPage(q(), input('subject'))!.previous!.values).toEqual({ speed: 6.5, distance: 20_000, elapsed: 1800 })
  })

  it('names the fastest kilometre of this type from the splits', () => {
    seedRun('fast', '2026-06-01', { splits: [{ distance: 1000, seconds: 290 }] })
    seedRun('subject', SUBJECT_DATE, { splits: [{ distance: 1000, seconds: 310 }] })
    expect(readWorkoutPage(q(), input('subject'))!.best.fastestKmSeconds).toEqual({ value: 290, sessionId: 'fast', localDate: '2026-06-01' })
  })

  it('names the furthest and the longest of this type, skipping an excluded one and another type', () => {
    seedRun('far', '2026-05-01', { distance: 12_000 }, { minutes: 50 })
    seedRun('long', '2026-06-01', { distance: 8000 }, { minutes: 95 })
    seedRun('dropped', '2026-07-01', { distance: 20_000 }, { minutes: 200, excluded: true })
    seedRide('ride', '2026-07-02', { distance: 60_000 }, { minutes: 180 })
    seedRun('subject', SUBJECT_DATE, { distance: 5000 })
    expect(readWorkoutPage(q(), input('subject'))!.best).toEqual({
      fastestKmSeconds: null,
      furthestMeters: { value: 12_000, sessionId: 'far', localDate: '2026-05-01' },
      longestMs: { value: 95 * 60_000, sessionId: 'long', localDate: '2026-06-01' },
    })
  })

  it('names the Records best, even when it was run after this workout', () => {
    seedRun('subject', '2026-08-01', { splits: [{ distance: 1000, seconds: 310 }] })
    seedRun('later', '2026-09-01', { splits: [{ distance: 1000, seconds: 280 }] })
    expect(readWorkoutPage(q(), input('subject'))!.best.fastestKmSeconds).toEqual({ value: 280, sessionId: 'later', localDate: '2026-09-01' })
  })

  it('never names a zero-second kilometre or a zero distance as a best', () => {
    seedRun('broken', '2026-06-01', { distance: 0, splits: [{ distance: 1000, seconds: 0 }] })
    // No distance on the subject, so a zero would be the only distance there is to name.
    seedRun('subject', SUBJECT_DATE, { splits: [{ distance: 1000, seconds: 310 }] })
    const { best } = readWorkoutPage(q(), input('subject'))!
    expect(best.fastestKmSeconds).toEqual({ value: 310, sessionId: 'subject', localDate: SUBJECT_DATE })
    expect(best.furthestMeters).toBeNull()
  })

  it('still reads a workout whose type is outside the known list, compared against nothing', () => {
    seedWorkout('odd', '2026-09-01', 'UNDERWATER_CHESS', { moving: 1200 })
    seedWorkout('subject', SUBJECT_DATE, 'UNDERWATER_CHESS', { moving: 1500 })
    const page = readWorkoutPage(q(), input('subject'))!
    expect(page.exerciseType).toBe('UNDERWATER_CHESS')
    expect(page.comparison).toMatchObject({ of: 0, reason: 'too-few' })
    expect(page.previous).toBeNull()
    expect(page.figures.movingTime).toMatchObject({ value: 1500, baseline: null })
  })

  it('leaves out a figure the workout does not have', () => {
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    expect(readWorkoutPage(q(), input('subject'))!.figures.cadence).toBeUndefined()
  })

  it('reads every figure from its own field, in its own unit', () => {
    seedRun('subject', SUBJECT_DATE, {
      pace: 300, distance: 5200, moving: 1500,
      metrics: {
        averageSpeedMillimetersPerSecond: 3333,
        averageHeartRateBeatsPerMinute: '151',
        caloriesKcal: 412,
        steps: '5100',
        activeZoneMinutes: '23',
        elevationGainMillimeters: 42_000,
        // 10, 5, 4 and 1 minutes: Edwards 10*1 + 5*2 + 4*3 + 1*4 = 36; hard zones (4 + 1) = 5.
        heartRateZoneDurations: { lightTime: '600s', moderateTime: '300s', vigorousTime: '240s', peakTime: '60s' },
        mobilityMetrics: {
          avgCadenceStepsPerMinute: 172, avgStrideLengthMillimeters: '1150', avgGroundContactTimeDuration: '0.256s',
          avgVerticalOscillationMillimeters: '88', avgVerticalRatio: 7.6,
        },
        runVo2Max: 48.5,
        totalSwimLengths: 12,
      },
    }, { minutes: 30 })
    const page = readWorkoutPage(q(), input('subject'))!
    expect(page.figures).toMatchObject({
      pace: { value: 300, unit: 'seconds_per_km', precision: 0, direction: 'down' },
      speed: { value: 3.333, unit: 'meters_per_second', precision: 2, direction: 'up' },
      distance: { value: 5200, unit: 'meters', direction: 'neutral' },
      movingTime: { value: 1500, unit: 'seconds' },
      elapsed: { value: 1800, unit: 'seconds' },
      averageHeartRate: { value: 151, unit: 'bpm' },
      cardioLoad: { value: 36, unit: 'trimp' },
      calories: { value: 412, unit: 'kcal' },
      steps: { value: 5100, unit: 'count' },
      activeZoneMinutes: { value: 23, unit: 'minutes' },
      elevationGain: { value: 42, unit: 'meters' },
      hardZoneMinutes: { value: 5, unit: 'minutes' },
      cadence: { value: 172, unit: 'steps_per_minute', precision: 0 },
      strideLength: { value: 1.15, unit: 'meters', precision: 2 },
      groundContact: { value: 0.256, unit: 'seconds', precision: 3 },
      verticalOscillation: { value: 0.088, unit: 'meters', precision: 3 },
      verticalRatio: { value: 7.6, unit: 'ratio', precision: 1 },
      vo2max: { value: 48.5, unit: 'ml_per_kg_min', direction: 'up' },
      swimLengths: { value: 12, unit: 'count' },
    })
    // No profile and no heart rate: neither of the two heart-rate figures has anything to read.
    expect(page.figures.banister).toBeUndefined()
    expect(page.figures.highestHeartRate).toBeUndefined()
  })

  it('reads the highest heart rate and the Banister load for this session alone, with no usual range', () => {
    seedRuns(6, { pace: 330 })
    seedRun('subject', SUBJECT_DATE, { pace: 300 }, { minutes: 30 })
    const startMs = at(SUBJECT_DATE, '07:00')
    // A reading before the session is higher still, and must not be the session's highest.
    seedHeartRate(startMs - 10 * 60_000, [190])
    seedHeartRate(startMs, Array.from({ length: 30 }, (_, i) => (i === 17 ? 178 : 140 + (i % 5))))
    new PeopleStore(test.db).setBirthDate('p1', '1985-03-04')
    new PeopleStore(test.db).setSex('p1', 'male')
    seedDaily(SUBJECT_DATE, 'resting_heart_rate', 'last', 52)
    const page = readWorkoutPage(q(), input('subject'))!
    expect(page.figures.highestHeartRate).toMatchObject({ value: 178, unit: 'bpm', baseline: null, standing: null, judged: null })
    const banister = q().cardioLoad({ sessionId: 'subject' })!.banister!
    expect(banister).toBeGreaterThan(0)
    expect(page.figures.banister).toMatchObject({ value: banister, unit: 'trimp', baseline: null, standing: null })
  })

  it('says how much faster the second half of the kilometres went than the first, distance-weighted', () => {
    // First half 330 and 320 s/km; second half 300 over a full kilometre and 280 over a fifth of
    // one. By distance the second half is (300 + 56) / 1.2 = 296.67 s/km, 28.33 faster than 325;
    // a plain mean of the four paces would say 35.
    seedRun('subject', SUBJECT_DATE, { splits: [
      { distance: 1000, seconds: 330 }, { distance: 1000, seconds: 320 },
      { distance: 1000, seconds: 300 }, { distance: 200, seconds: 56 },
    ] })
    expect(readWorkoutPage(q(), input('subject'))!.splitTrend!.secondHalfFasterBySecondsPerKm).toBeCloseTo(28.333, 2)
  })

  it('leaves the middle kilometre out of an odd count, and reads a slower second half as negative', () => {
    seedRun('subject', SUBJECT_DATE, { splits: [
      { distance: 1000, seconds: 300 }, { distance: 1000, seconds: 999 }, { distance: 1000, seconds: 310 },
    ] })
    expect(readWorkoutPage(q(), input('subject'))!.splitTrend).toEqual({ secondHalfFasterBySecondsPerKm: -10 })
  })

  it('skips a split with no pace, no distance or a zero distance, rather than letting it into a half', () => {
    const split = (pace: number | null, distance: number | null) => ({
      startMs: null, endMs: null, splitType: 'DISTANCE', activeDurationSeconds: null, distanceMeters: distance,
      paceSecondsPerKm: pace, averageHeartRateBpm: null,
    })
    // Without the skip there are five splits: the halves are the first two and the last two, and
    // the unreadable ones poison both. With it, 330 against 300.
    expect(splitTrendOf([split(330, 1000), split(null, 1000), split(999, null), split(999, 0), split(300, 1000)]))
      .toEqual({ secondHalfFasterBySecondsPerKm: 30 })
    expect(splitTrendOf([split(330, 1000), split(null, 1000)])).toBeNull()
  })

  it('claims no split trend with fewer than two kilometres', () => {
    seedRun('one', SUBJECT_DATE, { splits: [{ distance: 1000, seconds: 300 }] })
    seedRun('none', SUBJECT_DATE, { pace: 300 }, { hhmm: '18:00' })
    expect(readWorkoutPage(q(), input('one'))!.splitTrend).toBeNull()
    expect(readWorkoutPage(q(), input('none'))!.splitTrend).toBeNull()
  })

  it("draws the zones from the provider's ceilings for the day, the ones the Banister load's maximum is read from", () => {
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    seedDaily(SUBJECT_DATE, 'heart_rate_zone_light_max_bpm', 'last', 113)
    seedDaily(SUBJECT_DATE, 'heart_rate_zone_moderate_max_bpm', 'last', 137)
    seedDaily(SUBJECT_DATE, 'heart_rate_zone_vigorous_max_bpm', 'last', 162)
    seedDaily(SUBJECT_DATE, 'heart_rate_zone_peak_max_bpm', 'last', 187)
    expect(readWorkoutPage(q(), input('subject'))!.zoneBounds).toEqual({ moderateMin: 113, vigorousMin: 137, peakMin: 162, max: 187 })
  })

  it('draws no zones when a ceiling is missing or the ceilings are out of order, rather than inventing one', () => {
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    seedDaily(SUBJECT_DATE, 'heart_rate_zone_light_max_bpm', 'last', 113)
    seedDaily(SUBJECT_DATE, 'heart_rate_zone_moderate_max_bpm', 'last', 137)
    seedDaily(SUBJECT_DATE, 'heart_rate_zone_peak_max_bpm', 'last', 187)
    expect(readWorkoutPage(q(), input('subject'))!.zoneBounds).toBeNull()
    seedDaily(SUBJECT_DATE, 'heart_rate_zone_vigorous_max_bpm', 'last', 130)
    expect(readWorkoutPage(q(), input('subject'))!.zoneBounds).toBeNull()
  })

  it('leads with speed for a ride, with moving time for a strength session, and with elapsed time when that is all there is', () => {
    seedRide('ride', SUBJECT_DATE, { pace: 120, metrics: { averageSpeedMillimetersPerSecond: 8000 } })
    seedWorkout('lift', '2026-09-05', 'STRENGTH_TRAINING', { moving: 2400 })
    seedWorkout('plain', '2026-09-06', 'STRENGTH_TRAINING', {})
    expect(readWorkoutPage(q(), input('ride'))!.hero).toBe('speed')
    expect(readWorkoutPage(q(), input('lift'))!.hero).toBe('movingTime')
    expect(readWorkoutPage(q(), input('plain'))!.hero).toBe('elapsed')
  })

  it('leads with pace on a walk and a hike, and with speed on any cycling type', () => {
    const speed = { averageSpeedMillimetersPerSecond: 5000 }
    seedWorkout('walk', SUBJECT_DATE, 'WALKING', { pace: 600, metrics: speed })
    seedWorkout('hike', '2026-09-05', 'HIKING', { pace: 700, metrics: speed })
    seedWorkout('hand', '2026-09-06', 'HAND_CYCLING', { pace: 200, metrics: speed })
    expect(readWorkoutPage(q(), input('walk'))!.hero).toBe('pace')
    expect(readWorkoutPage(q(), input('hike'))!.hero).toBe('pace')
    expect(readWorkoutPage(q(), input('hand'))!.hero).toBe('speed')
  })

  it('carries the comparison against the same window', () => {
    seedRuns(7, { pace: 330 })
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    const page = readWorkoutPage(q(), input('subject'))!
    const candidates = q().sessions({ kind: 'exercise', from: '1970-01-01', to: SUBJECT_DATE, type: 'RUNNING' })
    expect(page.comparison).toEqual(compareWorkout(q().sessionById({ sessionId: 'subject' })!, candidates))
    expect(page.comparison).toMatchObject({ of: 7, pace: { better: 7, of: 7 } })
  })

  it('links the night after and the workouts before and after', () => {
    seedRun('before', '2026-09-02', {}); seedRun('subject', SUBJECT_DATE, {}); seedRide('after', '2026-09-05', {})
    seedNight('2026-09-05', { asleep: 431, deep: 77 })
    seedDaily('2026-09-05', 'resting_heart_rate', 'last', 49)
    const page = readWorkoutPage(q(), input('subject'))!
    expect(page.nav).toEqual({ previous: 'before', next: 'after' })
    expect(page.after.night).toMatchObject({ localDate: '2026-09-05', asleep: { value: 431 }, deep: { value: 77 } })
    expect(page.after.restingHeartRate).toMatchObject({ metric: 'resting_heart_rate', value: 49 })
  })

  it('orders two workouts started at the same instant by id', () => {
    // Zero-length rides: a session with no duration never merges into another (sessionOverlap.ts),
    // so three rows at one instant stay three workouts rather than one merged event.
    seedRun('b-subject', SUBJECT_DATE, {})
    seedRide('a-ride', SUBJECT_DATE, {}, { minutes: 0 }); seedRide('c-ride', SUBJECT_DATE, {}, { minutes: 0 })
    expect(readWorkoutPage(q(), input('b-subject'))!.nav).toEqual({ previous: 'a-ride', next: 'c-ride' })
  })

  it('has no night after a workout done today', () => {
    seedRun('subject', TODAY, {})
    seedNight(shiftLocalDate(TODAY, 1), {})
    expect(readWorkoutPage(q(), input('subject'))!.after).toEqual({ night: null, restingHeartRate: null })
  })

  it('pairs the workout with its day: steps, active minutes, and the other workouts that day', () => {
    seedRun('subject', SUBJECT_DATE, {})
    seedRide('commute', SUBJECT_DATE, {}, { hhmm: '17:30' })
    seedRun('yesterday', '2026-09-03', {})
    seedDaily(SUBJECT_DATE, 'steps', 'sum', 12_340)
    seedDaily(SUBJECT_DATE, 'active_minutes_light', 'sum', 30)
    seedDaily(SUBJECT_DATE, 'active_minutes_vigorous', 'sum', 25)
    const { day } = readWorkoutPage(q(), input('subject'))!
    expect(day.steps).toMatchObject({ metric: 'steps', value: 12_340 })
    // Up, the direction of the three levels it sums: 'active_minutes' is no catalogue id, and read
    // as its own name it would come out neutral and never be judged.
    expect(day.activeMinutes).toMatchObject({ metric: 'active_minutes', value: 55, direction: 'up' })
    expect(day.otherWorkouts.map((w) => w.id)).toEqual(['commute'])
  })
})

describe('PersonQuery.workoutPage', () => {
  it('refuses an empty session id and a malformed today, and names no person by default', () => {
    seedRun('subject', SUBJECT_DATE, {})
    expect(() => q().workoutPage({ ...input(''), nameOf: undefined })).toThrow(/sessionId/)
    expect(() => q().workoutPage({ ...input('subject'), today: '2026-9-10' })).toThrow(/today/)
    expect(q().workoutPage({ sessionId: 'subject', today: TODAY, nowMs: 0 })?.sessionId).toBe('subject')
  })
})
