import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, seedPerson, insertSample, seedOverride } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sources, sessions, sessionRoutes, sessionSegments } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { shiftLocalDate } from '../src/derive/localDay.ts'
import { sampleTarget, sessionTarget } from '../src/derive/targetKey.ts'
import { PeopleStore } from '../src/store/people.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { readWorkoutPage, splitTrendOf } from '../src/query/workoutPage.ts'
import { compareWorkout } from '../src/api/workoutComparison.ts'
import { fastestEfforts, fastestEffortsAlong } from '../src/api/fastestEfforts.ts'

// Both as themselves, only watched: a run's own efforts are found once however many readers want them.
vi.mock('../src/api/fastestEfforts.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/fastestEfforts.ts')>()
  return { ...actual, fastestEfforts: vi.fn(actual.fastestEfforts), fastestEffortsAlong: vi.fn(actual.fastestEffortsAlong) }
})

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

// Metres per degree of latitude on the 6,371 km sphere, and per degree of longitude at 52 N.
const metresPerDegree = (6_371_000 * Math.PI) / 180
const lonMetres = metresPerDegree * Math.cos((52 * Math.PI) / 180)

/** A route from the session's start, a fix every 10 s at `speed` m/s for `fixes` fixes, heading `north` or `east`. */
function seedRoute(sessionId: string, localDate: string, o: { speed?: number, fixes?: number, heading?: 'north' | 'east', hhmm?: string } = {}) {
  const startMs = at(localDate, o.hhmm ?? '07:00')
  const step = (o.speed ?? 3) * 10
  test.db.insert(sessionRoutes).values(Array.from({ length: (o.fixes ?? 70) + 1 }, (_, i) => ({
    id: `${sessionId}-${i}`, sessionId, ordinal: i, atMs: startMs + i * 10_000,
    latitude: 52 + (o.heading === 'east' ? 0 : (i * step) / metresPerDegree),
    longitude: 5 + (o.heading === 'east' ? (i * step) / lonMetres : 0),
    altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
  }))).run()
}

/** Heart rate around a 30-minute workout's end at 07:30: its last minute, the minute of the end, and the two after. */
const seedRecovery = (localDate: string, bpms: readonly number[], sourceId = 'watch') => bpms.forEach((bpm, i) => {
  for (const agg of ['min', 'mean', 'max'] as const) {
    insertSample(test.db, { personId: 'p1', sourceId, metric: 'heart_rate', utcMs: at(localDate, '07:29') + i * 60_000, tzOffsetMinutes: OFFSET, agg, value: bpm })
  }
})

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
    expect(readWorkoutPage(q(), input('subject'))!.best['fastest-1k']).toEqual({ value: 290, sessionId: 'fast', localDate: '2026-06-01' })
  })

  it('names the furthest and the longest of this type, skipping an excluded one and another type', () => {
    seedRun('far', '2026-05-01', { distance: 12_000 }, { minutes: 50 })
    seedRun('long', '2026-06-01', { distance: 8000 }, { minutes: 95 })
    seedRun('dropped', '2026-07-01', { distance: 20_000 }, { minutes: 200, excluded: true })
    seedRide('ride', '2026-07-02', { distance: 60_000 }, { minutes: 180 })
    seedRun('subject', SUBJECT_DATE, { distance: 5000 })
    expect(readWorkoutPage(q(), input('subject'))!.best).toEqual({
      longest: { value: 95 * 60_000, sessionId: 'long', localDate: '2026-06-01' },
      furthest: { value: 12_000, sessionId: 'far', localDate: '2026-05-01' },
      'most-climb': null,
      'fastest-1k': null, 'fastest-mile': null, 'fastest-5k': null,
      'fastest-10k': null, 'fastest-half': null, 'fastest-marathon': null,
    })
  })

  it('names the Records best, even when it was run after this workout', () => {
    seedRun('subject', '2026-08-01', { splits: [{ distance: 1000, seconds: 310 }] })
    seedRun('later', '2026-09-01', { splits: [{ distance: 1000, seconds: 280 }] })
    expect(readWorkoutPage(q(), input('subject'))!.best['fastest-1k']).toEqual({ value: 280, sessionId: 'later', localDate: '2026-09-01' })
  })

  it('never names a zero-second kilometre or a zero distance as a best', () => {
    seedRun('broken', '2026-06-01', { distance: 0, splits: [{ distance: 1000, seconds: 0 }] })
    // No distance on the subject, so a zero would be the only distance there is to name.
    seedRun('subject', SUBJECT_DATE, { splits: [{ distance: 1000, seconds: 310 }] })
    const { best } = readWorkoutPage(q(), input('subject'))!
    expect(best['fastest-1k']).toEqual({ value: 310, sessionId: 'subject', localDate: SUBJECT_DATE })
    expect(best.furthest).toBeNull()
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
    expect(readWorkoutPage(q(), input('subject'))!.splitTrend).toEqual({ secondHalfFasterBySecondsPerKm: expect.closeTo(28.333, 2) })
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
    seedRide('ride', SUBJECT_DATE, { pace: 120, distance: 20_000, metrics: { averageSpeedMillimetersPerSecond: 8000 } })
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
    seedWorkout('hand', '2026-09-06', 'HAND_CYCLING', { pace: 200, distance: 9000, metrics: speed })
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

describe('readWorkoutPage: heart-rate recovery', () => {
  const END = at(SUBJECT_DATE, '07:30')

  it('reads how far heart rate fell one and two minutes after the end, judged against the earlier runs', () => {
    seedRuns(10, { pace: 330 })
    // Each earlier run fell 18 or 22 in the first minute and 30 or 34 in two.
    for (let i = 0; i < 10; i += 1) {
      const d = i % 2 === 0 ? 2 : -2
      seedRecovery(shiftLocalDate(SUBJECT_DATE, -3 * (10 - i)), [160, 150, 140 + d, 128 + d])
    }
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    seedRecovery(SUBJECT_DATE, [160, 150, 135, 118])
    const { heartRateRecovery } = readWorkoutPage(q(), input('subject'))!
    expect(heartRateRecovery!.oneMinute).toMatchObject({
      value: 25, unit: 'bpm', precision: 0, direction: 'up', standing: 'above', judged: 'better',
      baseline: { center: 20, thin: false },
    })
    expect(heartRateRecovery!.twoMinutes).toMatchObject({ value: 42, standing: 'above', baseline: { center: 32, thin: false } })
    // The minute means each fall is taken between: the last full minute, then each minute after.
    expect(heartRateRecovery!.readings).toEqual({ endBpm: 160, oneMinuteBpm: 135, twoMinutesBpm: 118 })
    expect(heartRateRecovery!.history).toBe(10)
  })

  it('judges against the latest ten runs alone, leaving older ones out of the usual', () => {
    seedRuns(12, { pace: 330 })
    // The two oldest fell 2 and 58 in the first minute, the ten after them 18 or 22.
    for (let i = 0; i < 12; i += 1) {
      const fall = i === 0 ? 2 : i === 1 ? 58 : i % 2 === 0 ? 22 : 18
      seedRecovery(shiftLocalDate(SUBJECT_DATE, -3 * (12 - i)), [160, 150, 160 - fall, 130])
    }
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    seedRecovery(SUBJECT_DATE, [160, 150, 135, 118])
    const { oneMinute, history } = readWorkoutPage(q(), input('subject'))!.heartRateRecovery!
    // Twelve earlier runs, ten of them read.
    expect(history).toBe(10)
    expect(oneMinute.baseline!.center).toBe(20)
    expect(oneMinute.baseline!.high).toBeCloseTo(20 + Math.sqrt(40 / 9), 6)
  })

  it('claims no standing on fewer than five earlier runs with heart rate after them', () => {
    seedRuns(10, { pace: 330 })
    for (let i = 0; i < 4; i += 1) seedRecovery(shiftLocalDate(SUBJECT_DATE, -3 * (10 - i)), [160, 150, 140, 128])
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    seedRecovery(SUBJECT_DATE, [160, 150, 135, 118])
    expect(readWorkoutPage(q(), input('subject'))!.heartRateRecovery!.oneMinute).toMatchObject({ value: 25, standing: null, baseline: { thin: true } })
    // Ten earlier runs, four with heart rate after them: the usual is built from four.
    expect(readWorkoutPage(q(), input('subject'))!.heartRateRecovery!.history).toBe(4)
  })

  it('reads the minutes around the minute the run ended in, when it ended part way through one', () => {
    // Ended at 07:30:30: 07:29 is the last full minute, 07:31 and 07:32 the minutes one and two after.
    seedRun('subject', SUBJECT_DATE, { pace: 300 }, { minutes: 30.5 })
    seedRecovery(SUBJECT_DATE, [160, 150, 135, 118])
    expect(readWorkoutPage(q(), input('subject'))!.heartRateRecovery).toMatchObject({ oneMinute: { value: 25 }, twoMinutes: { value: 42 } })
  })

  it('takes each fall between the readings rounded to whole bpm, so the printed pair and fall agree', () => {
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    // Unrounded, 160.6 to 139.4 falls 21.2; printed as 161 and 139, the fall must be 22.
    seedRecovery(SUBJECT_DATE, [160.6, 150, 139.4, 118.5])
    expect(readWorkoutPage(q(), input('subject'))!.heartRateRecovery).toMatchObject({
      oneMinute: { value: 22 }, twoMinutes: { value: 42 }, readings: { endBpm: 161, oneMinuteBpm: 139, twoMinutesBpm: 119 },
    })
  })

  it('leaves out an excluded minute, and reads the other one without it', () => {
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    seedRecovery(SUBJECT_DATE, [160, 150, 135, 118])
    seedOverride(test.db, { personId: 'p1', scope: 'sample', targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: at(SUBJECT_DATE, '07:31') }) })
    expect(readWorkoutPage(q(), input('subject'))!.heartRateRecovery).toMatchObject({
      oneMinute: { value: null }, twoMinutes: { value: 42 }, readings: { endBpm: 160, oneMinuteBpm: null, twoMinutesBpm: 118 },
    })
  })

  it('is null with no heart rate after the end, even with heart rate during the run', () => {
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    seedHeartRate(END - 30 * 60_000, Array(30).fill(150))
    expect(readWorkoutPage(q(), input('subject'))!.heartRateRecovery).toBeNull()
  })

  it("reads the workout's own device first, and another only when it recorded nothing", () => {
    test.db.insert(sources).values({ id: 'strap', personId: 'p1', externalId: 'strap', displayName: 'Strap', kind: 'device', createdAtMs: 0 }).run()
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    seedRecovery(SUBJECT_DATE, [150, 140, 100, 90], 'strap')
    expect(readWorkoutPage(q(), input('subject'))!.heartRateRecovery!.oneMinute.value).toBe(50)
    seedRecovery(SUBJECT_DATE, [160, 150, 135, 118])
    expect(readWorkoutPage(q(), input('subject'))!.heartRateRecovery!.oneMinute.value).toBe(25)
  })
})

describe('readWorkoutPage: the morning before', () => {
  /** Sixty days of the recovery index's inputs up to and including `to`, enough for it to score. */
  function seedRecoveryInputs(to: string) {
    for (let i = 0; i < 60; i += 1) {
      const localDate = shiftLocalDate(to, -i)
      seedDaily(localDate, 'daily_hrv', 'last', 40 + (i % 5))
      seedDaily(localDate, 'resting_heart_rate', 'last', 55 + (i % 3))
      seedDaily(localDate, 'sleep_bedtime_minutes', 'last', -30)
      if (localDate !== to) seedDaily(localDate, 'sleep_asleep_minutes', 'sum', 420)
    }
  }

  it("pairs the workout with the night ending on its date and that morning's recovery", () => {
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    seedRecoveryInputs(SUBJECT_DATE)
    seedNight(SUBJECT_DATE, { asleep: 410, deep: 70 })
    const { before } = readWorkoutPage(q(), input('subject'))!
    expect(before.night).toMatchObject({ localDate: SUBJECT_DATE, asleep: { value: 410 }, deep: { value: 70 } })
    expect(before.recovery!.index.value).not.toBeNull()
    expect(before.recovery!.index.asOfDate).toBe(SUBJECT_DATE)
    // Judged like the night page's, a higher resting heart rate worse, with its strip.
    expect(before.restingHeartRate).toMatchObject({ metric: 'resting_heart_rate', value: 55, direction: 'down' })
    expect(before.restingHeartRate!.strip).toHaveLength(7)
  })

  it('has nothing before a workout on a date without a night or morning readings', () => {
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    seedNight(shiftLocalDate(SUBJECT_DATE, 1), {})
    seedDaily(shiftLocalDate(SUBJECT_DATE, 1), 'resting_heart_rate', 'last', 50)
    expect(readWorkoutPage(q(), input('subject'))!.before).toEqual({ night: null, recovery: null, restingHeartRate: null })
  })
})

describe('readWorkoutPage: through the workout', () => {
  it("draws pace from the route's own timestamps, nothing past the end, and nothing without a route", () => {
    // Three minutes of fixes on a two-minute run: the recording ran on after the end.
    seedRun('subject', SUBJECT_DATE, { pace: 300 }, { minutes: 2 })
    seedRun('bare', SUBJECT_DATE, { pace: 300 }, { hhmm: '18:00' })
    const startMs = at(SUBJECT_DATE, '07:00')
    test.db.insert(sessionRoutes).values(Array.from({ length: 19 }, (_, i) => ({
      id: `subject-${i}`, sessionId: 'subject', ordinal: i, atMs: startMs + i * 10_000,
      latitude: 52 + (i * 30) / metresPerDegree, longitude: 5,
      altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
    }))).run()
    const { pace } = readWorkoutPage(q(), input('subject'))!.through
    expect(pace!.points.map((p) => p.elapsedSeconds)).toEqual([0, 60])
    expect(pace!.points[0]!.value).toBeCloseTo(1000 / 3, 1)
    expect(pace!.fastest).toEqual({ secondsPerKm: pace!.points[0]!.value, elapsedSeconds: 0 })
    expect(readWorkoutPage(q(), input('bare'))!.through.pace).toBeNull()
  })

  it("draws cadence from the workout's own device's minute steps, and nothing from hourly ones", () => {
    test.db.insert(sources).values({ id: 'phone', personId: 'p1', externalId: 'phone', displayName: 'Phone', kind: 'device', createdAtMs: 0 }).run()
    seedRun('subject', SUBJECT_DATE, { pace: 300 })
    seedRun('hourly', '2026-09-05', { pace: 300 }, { minutes: 180 })
    const startMs = at(SUBJECT_DATE, '07:00')
    // Two half-minute rows a minute, added into the minute's 170; the phone's own count is not the watch's.
    for (let i = 0; i < 60; i += 1) {
      insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: startMs + i * 30_000, tzOffsetMinutes: OFFSET, value: 85 })
      insertSample(test.db, { personId: 'p1', sourceId: 'phone', metric: 'steps', utcMs: startMs + i * 30_000, tzOffsetMinutes: OFFSET, value: 40 })
    }
    // An excluded row takes its minute out rather than leaving half of it.
    seedOverride(test.db, { personId: 'p1', scope: 'sample', targetKey: sampleTarget({ source: 'watch', metric: 'steps', utcMs: startMs + 20 * 30_000 }) })
    for (let i = 0; i < 3; i += 1) {
      insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: at('2026-09-05', '07:00') + i * 3_600_000, tzOffsetMinutes: OFFSET, value: 9000 })
    }
    const { cadence } = readWorkoutPage(q(), input('subject'))!.through
    expect(cadence!.points).toHaveLength(29)
    expect(cadence!.points.map((p) => p.elapsedSeconds)).not.toContain(600)
    expect(cadence!.points.every((p) => p.value === 170)).toBe(true)
    expect(readWorkoutPage(q(), input('hourly'))!.through.cadence).toBeNull()
  })

  it('reads no cadence for a workout longer than the window read allows, rather than refusing the page', () => {
    seedRun('subject', SUBJECT_DATE, { pace: 300 }, { minutes: 49 * 60 })
    expect(readWorkoutPage(q(), input('subject'))!.through.cadence).toBeNull()
  })
})

describe('readWorkoutPage: this route and fastest efforts', () => {
  /** `n` runs on the same 2.1 km route, every third day before SUBJECT_DATE, moving time alternating 600 +/- 10 s. */
  function seedRouteRuns(n: number) {
    for (let i = 0; i < n; i += 1) {
      const localDate = shiftLocalDate(SUBJECT_DATE, -3 * (n - i))
      seedRun(`route-${i}`, localDate, { moving: 600 + (i % 2 === 0 ? 10 : -10) })
      seedRoute(`route-${i}`, localDate)
    }
  }

  it('judges the time against the earlier times on the same route, with a strip and the previous one', () => {
    seedRouteRuns(11)
    // Another route, an excluded run, and one after: none of them count. The loop test below runs
    // the same course the other way.
    seedRun('elsewhere', '2026-09-01', { moving: 900 }, { hhmm: '18:00' })
    seedRoute('elsewhere', '2026-09-01', { heading: 'east', hhmm: '18:00' })
    seedRun('dropped', '2026-09-02', { moving: 900 }, { excluded: true })
    seedRoute('dropped', '2026-09-02')
    seedRun('later', '2026-09-06', { moving: 900 })
    seedRoute('later', '2026-09-06')
    seedRun('subject', SUBJECT_DATE, { moving: 540 })
    seedRoute('subject', SUBJECT_DATE)
    const { sameRoute } = readWorkoutPage(q(), input('subject'))!
    expect(sameRoute!.times).toBe(12)
    expect(sameRoute!.time).toMatchObject({ value: 540, unit: 'seconds', direction: 'down', standing: 'below', judged: 'better' })
    expect(sameRoute!.time.baseline!.thin).toBe(false)
    expect(sameRoute!.time.baseline!.center).toBeCloseTo(600 + 10 / 11)
    expect(sameRoute!.time.strip.map((p) => p.sessionId))
      .toEqual(['route-2', 'route-3', 'route-4', 'route-5', 'route-6', 'route-7', 'route-8', 'route-9', 'route-10', 'subject'])
    expect(sameRoute!.time.strip.at(-1)).toMatchObject({ value: 540, standing: 'below', judged: 'better' })
    expect(sameRoute!.previous).toEqual({ sessionId: 'route-10', localDate: shiftLocalDate(SUBJECT_DATE, -3), seconds: 610 })
  })

  it('sets the pace against the earlier paces on the route, and dates the oldest time on it', () => {
    // Six runs on the loop with a pace, one without; a faster run elsewhere is no part of either.
    for (let i = 0; i < 6; i += 1) {
      const localDate = shiftLocalDate(SUBJECT_DATE, -3 * (7 - i))
      seedRun(`loop-${i}`, localDate, { moving: 600, pace: i % 2 === 0 ? 290 : 300 })
      seedRoute(`loop-${i}`, localDate)
    }
    seedRun('no-pace', shiftLocalDate(SUBJECT_DATE, -3), { moving: 600 })
    seedRoute('no-pace', shiftLocalDate(SUBJECT_DATE, -3))
    seedRun('elsewhere', shiftLocalDate(SUBJECT_DATE, -2), { moving: 600, pace: 200 })
    seedRoute('elsewhere', shiftLocalDate(SUBJECT_DATE, -2), { heading: 'east' })
    seedRun('subject', SUBJECT_DATE, { moving: 540, pace: 280 })
    seedRoute('subject', SUBJECT_DATE)
    const { sameRoute } = readWorkoutPage(q(), input('subject'))!
    expect(sameRoute!.times).toBe(8)
    // The oldest of the seven the count is of.
    expect(sameRoute!.since).toBe(shiftLocalDate(SUBJECT_DATE, -21))
    expect(sameRoute!.rate).toMatchObject({ key: 'pace', unit: 'seconds_per_km', direction: 'down', value: 280, standing: 'below', judged: 'better' })
    expect(sameRoute!.rate!.baseline!.center).toBeCloseTo(295)
    expect(sameRoute!.rate!.strip.map((p) => p.sessionId)).toEqual(['loop-0', 'loop-1', 'loop-2', 'loop-3', 'loop-4', 'loop-5', 'subject'])
  })

  it('has no pace on the route for a workout without one of its own', () => {
    seedRouteRuns(3)
    seedRun('subject', SUBJECT_DATE, { moving: 540 })
    seedRoute('subject', SUBJECT_DATE)
    const { sameRoute } = readWorkoutPage(q(), input('subject'))!
    expect(sameRoute!.rate).toBeNull()
    expect(sameRoute!.since).toBe(shiftLocalDate(SUBJECT_DATE, -9))
  })

  it('claims no standing on four earlier times on the route, and still draws them', () => {
    seedRouteRuns(4)
    seedRun('subject', SUBJECT_DATE, { moving: 540 })
    seedRoute('subject', SUBJECT_DATE)
    const { sameRoute } = readWorkoutPage(q(), input('subject'))!
    expect(sameRoute!.times).toBe(5)
    expect(sameRoute!.time.baseline!.thin).toBe(true)
    expect(sameRoute!.time.standing).toBeNull()
    expect(sameRoute!.time.strip.map((p) => p.sessionId)).toEqual(['route-0', 'route-1', 'route-2', 'route-3', 'subject'])
  })

  it('reads everyone\'s elapsed time for a workout that recorded no moving time', () => {
    seedRun('timed', '2026-08-30', { moving: 900 }, { minutes: 22 })
    seedRoute('timed', '2026-08-30')
    seedRun('before', '2026-09-01', {}, { minutes: 20 })
    seedRoute('before', '2026-09-01')
    seedRun('subject', SUBJECT_DATE, {}, { minutes: 25 })
    seedRoute('subject', SUBJECT_DATE)
    const { sameRoute } = readWorkoutPage(q(), input('subject'))!
    expect(sameRoute!.time).toMatchObject({ key: 'elapsed', metric: 'elapsed', value: 25 * 60 })
    // The earlier run's clock time, not the moving time it also recorded.
    expect(sameRoute!.time.strip.map((p) => [p.sessionId, p.value])).toEqual([['timed', 22 * 60], ['before', 20 * 60], ['subject', 25 * 60]])
    expect(sameRoute!.previous!.seconds).toBe(20 * 60)
  })

  it('sets a moving time only against earlier moving times on the route', () => {
    seedRun('timed', '2026-08-30', { moving: 600 }, { minutes: 30 })
    seedRoute('timed', '2026-08-30')
    seedRun('clock-only', '2026-09-01', {}, { minutes: 12 })
    seedRoute('clock-only', '2026-09-01')
    seedRun('subject', SUBJECT_DATE, { moving: 540 })
    seedRoute('subject', SUBJECT_DATE)
    const { sameRoute } = readWorkoutPage(q(), input('subject'))!
    expect(sameRoute!.time).toMatchObject({ key: 'movingTime', metric: 'movingTime', value: 540 })
    expect(sameRoute!.times).toBe(2)
    expect(sameRoute!.time.strip.map((p) => p.sessionId)).toEqual(['timed', 'subject'])
    expect(sameRoute!.previous).toMatchObject({ sessionId: 'timed', seconds: 600 })
  })

  it('leaves out the same loop run the other way', () => {
    // A 500 m square run anticlockwise, or clockwise when reversed: the same start, end and length,
    // only the direction differs.
    const seedLoop = (sessionId: string, localDate: string, reversed: boolean) => {
      const startMs = at(localDate, '07:00')
      const corners: [number, number][] = [[0, 0], [500, 0], [500, 500], [0, 500], [0, 0]]
      const path: [number, number][] = []
      for (let leg = 0; leg < 4; leg += 1) {
        const [x0, y0] = corners[leg]!
        const [x1, y1] = corners[leg + 1]!
        for (let i = 0; i < 50; i += 1) path.push([x0 + ((x1 - x0) * i) / 50, y0 + ((y1 - y0) * i) / 50])
      }
      path.push([0, 0])
      if (reversed) path.reverse()
      test.db.insert(sessionRoutes).values(path.map(([east, north], i) => ({
        id: `${sessionId}-${i}`, sessionId, ordinal: i, atMs: startMs + i * 10_000,
        latitude: 52 + north / metresPerDegree, longitude: 5 + east / lonMetres,
        altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
      }))).run()
    }
    seedRun('same-way', '2026-08-30', { moving: 600 })
    seedLoop('same-way', '2026-08-30', false)
    seedRun('other-way', '2026-09-01', { moving: 580 })
    seedLoop('other-way', '2026-09-01', true)
    seedRun('subject', SUBJECT_DATE, { moving: 540 })
    seedLoop('subject', SUBJECT_DATE, false)
    const { sameRoute } = readWorkoutPage(q(), input('subject'))!
    expect(sameRoute!.times).toBe(2)
    expect(sameRoute!.previous).toMatchObject({ sessionId: 'same-way' })
  })

  it('reads the earlier routes a hundred workouts to a query, and only this one in full', () => {
    const countRouteReads = () => {
      const prepare = vi.spyOn(test.db.$client, 'prepare')
      readWorkoutPage(q(), input('subject'))
      const count = prepare.mock.calls.filter(([source]) => String(source).includes('"session_routes"')).length
      prepare.mockRestore()
      return count
    }
    const seedEarlier = (from: number, to: number) => {
      for (let i = from; i < to; i += 1) {
        const localDate = shiftLocalDate(SUBJECT_DATE, -(i + 1))
        seedRun(`early-${i}`, localDate, { moving: 600 })
        seedRoute(`early-${i}`, localDate, { fixes: 1 })
      }
    }
    seedRun('subject', SUBJECT_DATE, { moving: 540 })
    seedRoute('subject', SUBJECT_DATE, { fixes: 1 })
    // The subject's own route, then two chunks of a hundred; the subject is never one of them.
    seedEarlier(0, 200)
    expect(countRouteReads()).toBe(3)
    // Only the subject's own read carries altitude and accuracy; the chunks read what a signature
    // and the efforts need.
    const prepare = vi.spyOn(test.db.$client, 'prepare')
    readWorkoutPage(q(), input('subject'))
    const routeReads = prepare.mock.calls.map(([source]) => String(source)).filter((source) => source.includes('"session_routes"'))
    prepare.mockRestore()
    expect(routeReads.map((source) => /altitude/.test(source))).toEqual([true, false, false])
    // 250 earlier routed runs: the subject's route and three chunks.
    seedEarlier(200, 250)
    expect(countRouteReads()).toBe(4)
  })

  it('has no route card without a route, or with no earlier run on it', () => {
    seedRouteRuns(5)
    seedRun('bare', SUBJECT_DATE, { moving: 540 })
    expect(readWorkoutPage(q(), input('bare'))!.sameRoute).toBeNull()
    seedRun('new-route', SUBJECT_DATE, { moving: 540 }, { hhmm: '18:00' })
    seedRoute('new-route', SUBJECT_DATE, { heading: 'east', hhmm: '18:00' })
    expect(readWorkoutPage(q(), input('new-route'))!.sameRoute).toBeNull()
  })

  it('sets each fastest effort against the best of the type, and says when this workout holds it', () => {
    // An earlier 1.2 km at 4 m/s holds the kilometre; only the subject's 6 km covers a mile and 5 km.
    seedRun('quick', '2026-09-01', {})
    seedRoute('quick', '2026-09-01', { speed: 4, fixes: 30 })
    seedRun('subject', SUBJECT_DATE, {})
    seedRoute('subject', SUBJECT_DATE, { fixes: 200 })
    const page = readWorkoutPage(q(), input('subject'))!
    expect(page.efforts!['1k']!.seconds).toBeCloseTo(1000 / 3, 1)
    expect(page.efforts!['1k']!.isBest).toBe(false)
    expect(page.efforts!['1k']!.source).toBe('gps')
    expect(page.efforts!['1k']!.best).toMatchObject({ sessionId: 'quick', localDate: '2026-09-01' })
    expect(page.efforts!['1k']!.best!.value).toBeCloseTo(250, 6)
    expect(page.efforts!.mile).toMatchObject({ isBest: true, best: { sessionId: 'subject' } })
    expect(page.efforts!['5k']).toMatchObject({ isBest: true, best: { sessionId: 'subject' } })
    // The Records best reads the GPS kilometre too, so the two cannot disagree.
    expect(page.best['fastest-1k']).toMatchObject({ sessionId: 'quick' })
    expect(readWorkoutPage(q(), input('quick'))!.efforts).toMatchObject({ '1k': { isBest: true }, mile: null, '5k': null })
    // Nothing in the page carries a coordinate.
    expect(JSON.stringify(page)).not.toMatch(/latitude|longitude/)
  })

  it('says where along the route each stretch began, and what best a new best beat', () => {
    // Before the subject: a 1.2 km at 4 m/s holds the kilometre, a 2 km at 2.5 m/s the mile. After
    // it, a 7.5 km at 5 m/s holds every distance now, but is no part of what this run beat.
    seedRun('quick', '2026-09-01', {})
    seedRoute('quick', '2026-09-01', { speed: 4, fixes: 30 })
    seedRun('slow-mile', '2026-09-02', {})
    seedRoute('slow-mile', '2026-09-02', { speed: 2.5, fixes: 80 })
    seedRun('later', '2026-09-06', {})
    seedRoute('later', '2026-09-06', { speed: 5, fixes: 150 })
    seedRun('subject', SUBJECT_DATE, {})
    seedRoute('subject', SUBJECT_DATE, { fixes: 200 })
    const { efforts } = readWorkoutPage(q(), input('subject'))!
    // Even 30 m legs: each fastest window is the first, ending on the first fix past its distance.
    expect(efforts!['1k']!.fromMeters).toBeCloseTo(20, 0)
    expect(efforts!.mile!.fromMeters).toBeCloseTo(1620 - 1609.344, 0)
    expect(efforts!['5k']!.fromMeters).toBeCloseTo(10, 0)
    expect(efforts!['1k']!.best).toMatchObject({ sessionId: 'later' })
    expect(efforts!['1k']!.previousBest).toMatchObject({ sessionId: 'quick', localDate: '2026-09-01' })
    expect(efforts!['1k']!.previousBest!.value).toBeCloseTo(250, 6)
    expect(efforts!.mile!.previousBest).toMatchObject({ sessionId: 'slow-mile' })
    expect(efforts!['5k']!.previousBest).toBeNull()
    // Read off the earlier run, whose own best is nothing before it.
    expect(readWorkoutPage(q(), input('quick'))!.efforts!['1k']).toMatchObject({ previousBest: null })
  })

  it("reads a ride's efforts over the ride's own distances, and none of a run's", () => {
    // 25 km at 8 m/s: a 20 km, no 40 km or 100 km. Its kilometre splits make no record.
    seedRide('ride', SUBJECT_DATE, { splits: [{ distance: 1000, seconds: 90 }] })
    seedRoute('ride', SUBJECT_DATE, { speed: 8, fixes: 313 })
    seedRun('run', SUBJECT_DATE, {}, { hhmm: '18:00' })
    seedRoute('run', SUBJECT_DATE, { fixes: 200, hhmm: '18:00' })
    const ride = readWorkoutPage(q(), input('ride'))!
    expect(Object.keys(ride.efforts!)).toEqual(['20k', '40k', '100k'])
    expect(ride.efforts!['20k']).toMatchObject({ source: 'gps', isBest: true, best: { sessionId: 'ride', value: 2500 } })
    expect(ride.efforts!['20k']!.seconds).toBeCloseTo(2500, 0)
    expect([ride.efforts!['40k'], ride.efforts!['100k']]).toEqual([null, null])
    expect(Object.keys(ride.best)).toEqual(['longest', 'furthest', 'most-climb', 'fastest-20k', 'fastest-40k', 'fastest-100k'])
    // An earlier, quicker ride holds the ride's 20 km, and the run's bests are the run's alone.
    seedRide('earlier-ride', '2026-09-01', {})
    seedRoute('earlier-ride', '2026-09-01', { speed: 10, fixes: 250 })
    expect(readWorkoutPage(q(), input('ride'))!.efforts!['20k']).toMatchObject({ isBest: false, best: { sessionId: 'earlier-ride', value: 2000 } })
    expect(readWorkoutPage(q(), input('run'))!.efforts!['5k']).toMatchObject({ isBest: true })
    expect(readWorkoutPage(q(), input('run'))!.best).not.toHaveProperty('fastest-20k')
  })

  it('reads no efforts off a treadmill run or an indoor ride, and lets neither hold a speed best', () => {
    seedWorkout('treadmill', SUBJECT_DATE, 'TREADMILL', { splits: [{ distance: 1000, seconds: 200 }] })
    seedRoute('treadmill', SUBJECT_DATE, { speed: 5, fixes: 200 })
    seedWorkout('spin', SUBJECT_DATE, 'SPINNING', {}, { hhmm: '18:00' })
    seedRoute('spin', SUBJECT_DATE, { speed: 12, fixes: 200, hhmm: '18:00' })
    expect(readWorkoutPage(q(), input('treadmill'))!.efforts).toBeNull()
    expect(readWorkoutPage(q(), input('treadmill'))!.best['fastest-1k']).toBeNull()
    expect(readWorkoutPage(q(), input('spin'))!.efforts).toBeNull()
  })

  it("names a treadmill run's and an indoor ride's bests as the category's, GPS efforts included", () => {
    // An outdoor run's 6 km route holds every run distance up to 5 km off GPS, quicker than any split;
    // an outdoor ride's 25 km route holds the ride's 20 km. The indoor subjects hold none of it.
    seedRun('road', '2026-08-01', { splits: [{ distance: 1000, seconds: 400 }] })
    seedRoute('road', '2026-08-01', { fixes: 200 })
    seedWorkout('treadmill', SUBJECT_DATE, 'TREADMILL', { splits: [{ distance: 1000, seconds: 380 }] })
    seedRide('outdoor', '2026-08-02', {})
    seedRoute('outdoor', '2026-08-02', { speed: 8, fixes: 313 })
    seedWorkout('spin', SUBJECT_DATE, 'STATIONARY_BIKE', {}, { hhmm: '18:00' })
    const records = q().allTime().sessionRecords
    const same = (sessionId: string, category: string) => {
      const { best } = readWorkoutPage(q(), input(sessionId))!
      const held = records.filter((r) => r.category === category)
      expect(held.some((r) => r.kind.startsWith('fastest-') && r.kind !== 'fastest-1k'), category).toBe(true)
      for (const record of held) {
        expect(best[record.kind], `${category} ${record.kind}`).toEqual({ value: record.value, sessionId: record.sessionId, localDate: record.localDate })
      }
    }
    same('treadmill', 'run')
    expect(readWorkoutPage(q(), input('treadmill'))!.best['fastest-1k']).toMatchObject({ sessionId: 'road', value: 333 })
    same('spin', 'ride')
    expect(readWorkoutPage(q(), input('spin'))!.best['fastest-20k']).toMatchObject({ sessionId: 'outdoor', value: 2500 })
    // Neither indoor page reads efforts of its own.
    expect(readWorkoutPage(q(), input('treadmill'))!.efforts).toBeNull()
    expect(readWorkoutPage(q(), input('spin'))!.efforts).toBeNull()
  })

  it("names a trail run's bests as the run category's, the same records the Records page holds", () => {
    // A road run holds the kilometre and the distance, a treadmill run the longest; the trail run
    // itself the climb. Every one of them is a run, and a ride is none of them.
    seedRun('road', '2026-08-01', { distance: 12_000, splits: [{ distance: 1000, seconds: 280 }] })
    seedWorkout('treadmill', '2026-08-02', 'TREADMILL', { distance: 20_000, splits: [{ distance: 1000, seconds: 200 }] }, { minutes: 150 })
    seedRide('ride', '2026-08-03', { distance: 60_000, splits: [{ distance: 1000, seconds: 90 }] }, { minutes: 200 })
    seedWorkout('subject', SUBJECT_DATE, 'TRAIL_RUN', { distance: 9000, metrics: { elevationGainMillimeters: 350_000 }, splits: [{ distance: 1000, seconds: 330 }] })
    const { best } = readWorkoutPage(q(), input('subject'))!
    expect(best).toMatchObject({
      longest: { sessionId: 'treadmill', value: 150 * 60_000 },
      furthest: { sessionId: 'road', value: 12_000 },
      'most-climb': { sessionId: 'subject', value: 350 },
      'fastest-1k': { sessionId: 'road', value: 280 },
    })
    const run = q().allTime().sessionRecords.filter((r) => r.category === 'run')
    for (const record of run) {
      expect(best[record.kind], record.kind).toEqual({ value: record.value, sessionId: record.sessionId, localDate: record.localDate })
    }
    expect(run.map((r) => r.kind)).toEqual(['longest', 'furthest', 'most-climb', 'fastest-1k'])
  })

  it('prints the kilometre Records holds, a split when it beat the GPS, and where that split began', () => {
    // 6 km at 3 m/s is a 333 s GPS kilometre; the second split, from 1 km, was run in 320 s.
    seedRun('subject', SUBJECT_DATE, { splits: [{ distance: 1000, seconds: 340 }, { distance: 1000, seconds: 320 }, { distance: 1000, seconds: 345 }] })
    seedRoute('subject', SUBJECT_DATE, { fixes: 200 })
    const page = readWorkoutPage(q(), input('subject'))!
    expect(page.efforts!['1k']).toMatchObject({ seconds: 320, fromMeters: 1000, source: 'split', isBest: true, best: { sessionId: 'subject', value: 320 } })
    expect(page.best['fastest-1k']).toMatchObject({ sessionId: 'subject', value: 320 })
    // The mile has no split, so it stays the GPS's.
    expect(page.efforts!.mile!.seconds).toBeCloseTo(536.4, 1)
    expect(page.efforts!.mile!.source).toBe('gps')
  })

  it("finds a run's own efforts once, for its row and both sets of records", () => {
    seedRun('subject', SUBJECT_DATE, {})
    seedRoute('subject', SUBJECT_DATE, { fixes: 200 })
    vi.mocked(fastestEffortsAlong).mockClear()
    vi.mocked(fastestEfforts).mockClear()
    expect(readWorkoutPage(q(), input('subject'))!.efforts!['5k']).toMatchObject({ isBest: true })
    expect(fastestEffortsAlong).toHaveBeenCalledTimes(1)
    expect(fastestEfforts).not.toHaveBeenCalled()
  })

  it("reads no later workout's route for a category without efforts, and every run's for a run's bests", () => {
    const summarised = (sessionId: string) => {
      const query = q()
      const spy = vi.spyOn(query, 'workoutRouteSummaries')
      readWorkoutPage(query, input(sessionId))
      const ids = spy.mock.calls.map(([call]) => call.sessions.map((s) => s.id))
      spy.mockRestore()
      return ids
    }
    seedWorkout('earlier-walk', '2026-09-01', 'WALKING', {})
    seedWorkout('walk', SUBJECT_DATE, 'WALKING', {})
    seedWorkout('later-walk', '2026-09-06', 'WALKING', {})
    expect(summarised('walk')).toEqual([['earlier-walk']])
    // In the evening, so no run overlaps a ride and merges with it.
    seedRun('earlier-run', '2026-09-01', {}, { hhmm: '18:00' })
    seedRun('run', SUBJECT_DATE, {}, { hhmm: '18:00' })
    seedRun('later-run', '2026-09-06', {}, { hhmm: '18:00' })
    expect(summarised('run')).toEqual([['earlier-run', 'later-run']])
    // A trail run's bests read every run's route that can hold a speed record: never a treadmill's.
    seedWorkout('trail', SUBJECT_DATE, 'TRAIL_RUN', {}, { hhmm: '12:00' })
    seedWorkout('treadmill', '2026-09-02', 'TREADMILL', {}, { hhmm: '12:00' })
    expect(summarised('trail')).toEqual([['earlier-run', 'run', 'later-run']])
  })

  it('has no efforts without a route', () => {
    seedRun('subject', SUBJECT_DATE, { splits: [{ distance: 1000, seconds: 300 }] })
    expect(readWorkoutPage(q(), input('subject'))!.efforts).toBeNull()
  })
})

describe('readWorkoutPage: per sport', () => {
  const mobility = {
    mobilityMetrics: {
      avgCadenceStepsPerMinute: 172, avgStrideLengthMillimeters: '1150', avgGroundContactTimeDuration: '0.256s',
      avgVerticalOscillationMillimeters: '88', avgVerticalRatio: 7.6,
    },
  }
  const FORM = ['cadence', 'strideLength', 'groundContact', 'verticalOscillation', 'verticalRatio'] as const

  it('leads a treadmill run with its pace, worked out from distance and moving time when the device sent none', () => {
    seedWorkout('treadmill', SUBJECT_DATE, 'TREADMILL', { distance: 6000, moving: 1800 })
    seedWorkout('sent', '2026-09-05', 'TREADMILL', { pace: 310, distance: 6000, moving: 1800 })
    seedWorkout('bare', '2026-09-06', 'TREADMILL', { moving: 1800 })
    const page = readWorkoutPage(q(), input('treadmill'))!
    expect(page.hero).toBe('pace')
    expect(page.figures.pace).toMatchObject({ value: 300, unit: 'seconds_per_km' })
    // The device's own pace, where it sent one, is the pace.
    expect(readWorkoutPage(q(), input('sent'))!.figures.pace!.value).toBe(310)
    // Without a distance there is no pace to work out.
    expect(readWorkoutPage(q(), input('bare'))!.hero).toBe('movingTime')
  })

  it('leads a trail and an incline run with pace, as a run', () => {
    seedWorkout('trail', SUBJECT_DATE, 'TRAIL_RUN', { pace: 400 })
    seedWorkout('track', '2026-09-05', 'TRACK_AND_FIELD', { pace: 250 })
    expect(readWorkoutPage(q(), input('trail'))!.hero).toBe('pace')
    expect(readWorkoutPage(q(), input('track'))!.hero).toBe('pace')
  })

  it('leads a ride with speed only when it covered a distance outdoors, and never shows a pace for it', () => {
    const speed = { averageSpeedMillimetersPerSecond: 7500 }
    seedWorkout('road', SUBJECT_DATE, 'BIKING', { pace: 133, distance: 27_000, moving: 3600, metrics: speed })
    seedWorkout('mtb', '2026-09-05', 'MOUNTAIN_BIKE', { distance: 20_000, moving: 4000 })
    seedWorkout('nodistance', '2026-09-06', 'BIKING', { moving: 3600, metrics: speed })
    seedWorkout('indoor', '2026-09-07', 'STATIONARY_BIKE', { distance: 27_000, moving: 3600, metrics: speed })
    const road = readWorkoutPage(q(), input('road'))!
    expect(road.hero).toBe('speed')
    expect(road.figures.pace).toBeUndefined()
    // No device speed: the distance over the moving time, 20 km in 4000 s.
    const mtb = readWorkoutPage(q(), input('mtb'))!
    expect(mtb.hero).toBe('speed')
    expect(mtb.figures.speed).toMatchObject({ value: 5, unit: 'meters_per_second', direction: 'up' })
    expect(readWorkoutPage(q(), input('nodistance'))!.hero).toBe('movingTime')
    expect(readWorkoutPage(q(), input('indoor'))!.hero).toBe('movingTime')
  })

  it('leads a swim with its pace per 100 m, and shows no pace per km and no climb for it', () => {
    seedWorkout('pool', SUBJECT_DATE, 'SWIMMING_POOL', {
      pace: 1200, distance: 1500, moving: 1800, metrics: { elevationGainMillimeters: 4000 },
    })
    seedWorkout('nodistance', '2026-09-05', 'SWIMMING', { moving: 1800 })
    const pool = readWorkoutPage(q(), input('pool'))!
    expect(pool.hero).toBe('swimPace')
    expect(pool.figures.swimPace).toMatchObject({ key: 'swimPace', value: 120, unit: 'seconds_per_100m', precision: 0, direction: 'down' })
    expect(pool.figures.pace).toBeUndefined()
    expect(pool.figures.elevationGain).toBeUndefined()
    expect(readWorkoutPage(q(), input('nodistance'))!.hero).toBe('movingTime')
  })

  it("sends a swim's distance under the metric that reads in whole metres, and a run's under its key", () => {
    seedWorkout('pool', SUBJECT_DATE, 'SWIMMING_POOL', { distance: 1500, moving: 1800 })
    seedWorkout('run', '2026-09-05', 'RUNNING', { pace: 300, distance: 1500, moving: 450 })
    expect(readWorkoutPage(q(), input('pool'))!.figures.distance).toMatchObject({ key: 'distance', metric: 'swimDistance', value: 1500 })
    expect(readWorkoutPage(q(), input('run'))!.figures.distance).toMatchObject({ key: 'distance', metric: 'distance', value: 1500 })
  })

  it('leads every other category with moving time, whatever rate it carries', () => {
    seedWorkout('hiit', SUBJECT_DATE, 'HIIT', { pace: 400, distance: 3000, moving: 1500, metrics: { averageSpeedMillimetersPerSecond: 2500 } })
    seedWorkout('lift', '2026-09-05', 'WEIGHTLIFTING', { pace: 400, distance: 3000, moving: 1500 })
    const hiit = readWorkoutPage(q(), input('hiit'))!
    expect(hiit.hero).toBe('movingTime')
    expect(hiit.figures.swimPace).toBeUndefined()
    expect(readWorkoutPage(q(), input('lift'))!.hero).toBe('movingTime')
  })

  it('shows step cadence and running form for a run and a walk alone', () => {
    seedWorkout('run', SUBJECT_DATE, 'RUNNING', { pace: 300, metrics: mobility })
    seedWorkout('walk', '2026-09-05', 'WALKING', { pace: 600, metrics: mobility })
    seedWorkout('ride', '2026-09-06', 'BIKING', { distance: 20_000, moving: 3000, metrics: mobility })
    seedWorkout('hiit', '2026-09-07', 'HIIT', { moving: 1500, metrics: mobility })
    for (const id of ['run', 'walk']) {
      const { figures } = readWorkoutPage(q(), input(id))!
      for (const key of FORM) expect(figures[key], `${id} ${key}`).toBeDefined()
    }
    for (const id of ['ride', 'hiit']) {
      const { figures } = readWorkoutPage(q(), input(id))!
      for (const key of FORM) expect(figures[key], `${id} ${key}`).toBeUndefined()
    }
  })

  it('reads no cadence series for a ride, however finely its device logged steps', () => {
    seedWorkout('walk', SUBJECT_DATE, 'WALKING', { pace: 600 })
    seedWorkout('ride', '2026-09-05', 'BIKING', { distance: 20_000, moving: 1800 })
    for (const localDate of [SUBJECT_DATE, '2026-09-05']) {
      for (let i = 0; i < 30; i += 1) {
        insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: at(localDate, '07:00') + i * 60_000, tzOffsetMinutes: OFFSET, value: 110 })
      }
    }
    expect(readWorkoutPage(q(), input('walk'))!.through.cadence).not.toBeNull()
    expect(readWorkoutPage(q(), input('ride'))!.through.cadence).toBeNull()
  })

  it('shows no climb for an indoor run, walk or ride, and keeps it outdoors and on an e-bike', () => {
    const climb = { elevationGainMillimeters: 50_000 }
    seedWorkout('treadmill', SUBJECT_DATE, 'TREADMILL', { distance: 5000, moving: 1500, metrics: climb })
    seedWorkout('treadwalk', '2026-09-05', 'TREADMILL_WALK', { distance: 3000, moving: 1800, metrics: climb })
    seedWorkout('spin', '2026-09-06', 'SPINNING', { moving: 2700, metrics: climb })
    seedWorkout('road', '2026-09-07', 'BIKING', { distance: 20_000, moving: 3000, metrics: climb })
    seedWorkout('ebike', '2026-09-08', 'ELECTRIC_BIKE', { distance: 20_000, moving: 3000, metrics: climb })
    for (const id of ['treadmill', 'treadwalk', 'spin']) expect(readWorkoutPage(q(), input(id))!.figures.elevationGain, id).toBeUndefined()
    for (const id of ['road', 'ebike']) expect(readWorkoutPage(q(), input(id))!.figures.elevationGain, id).toMatchObject({ value: 50 })
  })

  it('shows no climb for an incline treadmill or a cardio machine, and leaves their records to the record rule', () => {
    const climb = { elevationGainMillimeters: 50_000 }
    const machines = ['INCLINE_RUN', 'INCLINE_WALK', 'ELLIPTICAL', 'ROWING_MACHINE', 'STAIRCLIMBER']
    machines.forEach((type, i) => seedWorkout(type, shiftLocalDate(SUBJECT_DATE, i), type, { distance: 3000, moving: 1500, metrics: climb }))
    for (const type of machines) expect(readWorkoutPage(q(), input(type))!.figures.elevationGain, type).toBeUndefined()
    // Indoor is about the climb alone: an incline run still holds the run's distance records.
    expect(readWorkoutPage(q(), input('INCLINE_RUN'))!.best.furthest).toMatchObject({ sessionId: 'INCLINE_RUN', value: 3000 })
  })

  it("ranks a ride by the speed its hero shows, worked out where the device sent no pace", () => {
    // Four earlier rides at 5, 6, 7 and 8 m/s, none with a device pace or speed; this one at 7.5.
    ;[4000, 3333, 2857, 2500].forEach((moving, i) => seedWorkout(`ride-${i}`, shiftLocalDate(SUBJECT_DATE, -3 * (4 - i)), 'BIKING', { distance: 20_000, moving }))
    seedWorkout('subject', SUBJECT_DATE, 'BIKING', { distance: 20_000, moving: 2667 })
    const page = readWorkoutPage(q(), input('subject'))!
    expect(page.hero).toBe('speed')
    expect(page.comparison.pace).toBeNull()
    expect(page.rank).toEqual({ better: 3, of: 4 })
  })

  it("ranks a treadmill run by its worked-out pace, and a swim by its pace per 100 m", () => {
    // Treadmill: 330, 320, 290 s/km before; this one 300 s/km, faster than two.
    ;[1650, 1600, 1450].forEach((moving, i) => seedWorkout(`tm-${i}`, shiftLocalDate(SUBJECT_DATE, -3 * (3 - i)), 'TREADMILL', { distance: 5000, moving }))
    seedWorkout('treadmill', SUBJECT_DATE, 'TREADMILL', { distance: 5000, moving: 1500 })
    // Swims: 2:10, 2:00 and 2:10 a 100 m before; this one 2:00, faster than two, a tie never better.
    ;[1300, 1200, 1300].forEach((moving, i) => seedWorkout(`swim-${i}`, shiftLocalDate(SUBJECT_DATE, -3 * (3 - i)), 'SWIMMING_POOL', { distance: 1000, moving }, { hhmm: '18:00' }))
    seedWorkout('swim', SUBJECT_DATE, 'SWIMMING_POOL', { distance: 1000, moving: 1200 }, { hhmm: '18:00' })
    const treadmill = readWorkoutPage(q(), input('treadmill'))!
    expect(treadmill.comparison.pace).toBeNull()
    expect(treadmill.rank).toEqual({ better: 2, of: 3 })
    const swim = readWorkoutPage(q(), input('swim'))!
    expect(swim.hero).toBe('swimPace')
    expect(swim.rank).toEqual({ better: 2, of: 3 })
  })

  it('ranks nothing under a time hero, or with too few earlier workouts', () => {
    ;[2400, 2500, 2600].forEach((moving, i) => seedWorkout(`lift-${i}`, shiftLocalDate(SUBJECT_DATE, -3 * (3 - i)), 'WEIGHTLIFTING', { moving }))
    seedWorkout('lift', SUBJECT_DATE, 'WEIGHTLIFTING', { moving: 2700 })
    seedWorkout('ride-0', '2026-09-01', 'BIKING', { distance: 20_000, moving: 3000 })
    seedWorkout('ride', SUBJECT_DATE, 'BIKING', { distance: 20_000, moving: 2800 }, { hhmm: '18:00' })
    expect(readWorkoutPage(q(), input('lift'))!.rank).toBeNull()
    expect(readWorkoutPage(q(), input('ride'))!.rank).toBeNull()
  })

  it('reads heart-rate recovery after a run, a ride, a swim and a cardio session, and after nothing else', () => {
    const days = { RUNNING: '2026-08-01', BIKING: '2026-08-02', SWIMMING_POOL: '2026-08-03', HIIT: '2026-08-04', WALKING: '2026-08-05', WEIGHTLIFTING: '2026-08-06', YOGA: '2026-08-07' }
    for (const [type, localDate] of Object.entries(days)) {
      seedWorkout(type, localDate, type, { distance: 3000, moving: 1500 })
      seedRecovery(localDate, [160, 150, 135, 118])
    }
    for (const type of ['RUNNING', 'BIKING', 'SWIMMING_POOL', 'HIIT']) {
      expect(readWorkoutPage(q(), input(type))!.heartRateRecovery, type).toMatchObject({ oneMinute: { value: 25 } })
    }
    for (const type of ['WALKING', 'WEIGHTLIFTING', 'YOGA']) expect(readWorkoutPage(q(), input(type))!.heartRateRecovery, type).toBeNull()
  })

  it("draws a ride's speed through the workout in place of its pace", () => {
    seedWorkout('ride', SUBJECT_DATE, 'BIKING', { distance: 5000, moving: 700 }, { minutes: 12 })
    seedRoute('ride', SUBJECT_DATE, { speed: 8 })
    const { through } = readWorkoutPage(q(), input('ride'))!
    expect(through.pace).toBeNull()
    expect(through.speed!.unit).toBe('meters_per_second')
    expect(through.speed!.points[0]!.value).toBeCloseTo(8, 1)
    expect(through.speed!.fastest).toEqual({ metersPerSecond: expect.closeTo(8, 1), elapsedSeconds: expect.any(Number) })
  })

  it('draws a run\'s pace and no speed', () => {
    seedRun('run', SUBJECT_DATE, { pace: 300 }, { minutes: 12 })
    seedRoute('run', SUBJECT_DATE, { speed: 3 })
    const { through } = readWorkoutPage(q(), input('run'))!
    expect(through.speed).toBeNull()
    expect(through.pace!.points[0]!.value).toBeCloseTo(1000 / 3, 1)
  })

  it('reads a pause by the category: a slow walk still moves, a slow ride has stopped', () => {
    // 30 m a minute: over a walk's 20 m, under a run's 50 m.
    seedWorkout('walk', SUBJECT_DATE, 'WALKING', { pace: 2000 }, { minutes: 12 })
    seedRoute('walk', SUBJECT_DATE, { speed: 0.5 })
    seedRun('run', '2026-09-05', { pace: 2000 }, { minutes: 12 })
    seedRoute('run', '2026-09-05', { speed: 0.5 })
    // 120 m a minute: over a run's 50 m, under a ride's 150 m.
    seedWorkout('ride', '2026-09-06', 'BIKING', { distance: 1500, moving: 700 }, { minutes: 12 })
    seedRoute('ride', '2026-09-06', { speed: 2 })
    seedRun('jog', '2026-09-07', { pace: 500 }, { minutes: 12 })
    seedRoute('jog', '2026-09-07', { speed: 2 })
    expect(readWorkoutPage(q(), input('walk'))!.through.pace).not.toBeNull()
    expect(readWorkoutPage(q(), input('run'))!.through.pace).toBeNull()
    expect(readWorkoutPage(q(), input('ride'))!.through.speed).toBeNull()
    expect(readWorkoutPage(q(), input('jog'))!.through.pace).not.toBeNull()
  })

  it("sets a ride's speed against the earlier speeds on the route", () => {
    for (let i = 0; i < 5; i += 1) {
      const localDate = shiftLocalDate(SUBJECT_DATE, -3 * (5 - i))
      seedWorkout(`loop-${i}`, localDate, 'BIKING', { distance: 5600, moving: i % 2 === 0 ? 800 : 700 })
      seedRoute(`loop-${i}`, localDate, { speed: 8 })
    }
    seedWorkout('subject', SUBJECT_DATE, 'BIKING', { distance: 5600, moving: 560 })
    seedRoute('subject', SUBJECT_DATE, { speed: 8 })
    const rate = readWorkoutPage(q(), input('subject'))!.sameRoute!.rate!
    expect(rate).toMatchObject({ key: 'speed', unit: 'meters_per_second', direction: 'up', value: 10, standing: 'above', judged: 'better' })
    expect(rate.strip).toHaveLength(6)
  })

  it("sends the previous ride's worked-out speed and no pace, and the previous swim's pace per 100 m", () => {
    seedWorkout('ride-before', '2026-09-01', 'BIKING', { pace: 150, distance: 20_000, moving: 4000 })
    seedWorkout('ride', SUBJECT_DATE, 'BIKING', { distance: 20_000, moving: 3600 })
    seedWorkout('swim-before', '2026-09-01', 'SWIMMING_POOL', { distance: 1000, moving: 1300 }, { hhmm: '18:00' })
    seedWorkout('swim', SUBJECT_DATE, 'SWIMMING_POOL', { distance: 1000, moving: 1200 }, { hhmm: '18:00' })
    expect(readWorkoutPage(q(), input('ride'))!.previous!.values).toEqual({ speed: 5, distance: 20_000, movingTime: 4000, elapsed: 1800 })
    expect(readWorkoutPage(q(), input('swim'))!.previous!.values).toEqual({ swimPace: 130, distance: 1000, movingTime: 1300, elapsed: 1800 })
  })

  it("says how much faster the second half of a ride's kilometres went, in metres per second", () => {
    // 150 and 150 s against 120 and 120 s a kilometre: 6.67 m/s then 8.33 m/s.
    seedWorkout('ride', SUBJECT_DATE, 'BIKING', { splits: [
      { distance: 1000, seconds: 150 }, { distance: 1000, seconds: 150 },
      { distance: 1000, seconds: 120 }, { distance: 1000, seconds: 120 },
    ] })
    expect(readWorkoutPage(q(), input('ride'))!.splitTrend).toEqual({ secondHalfFasterByMetersPerSecond: expect.closeTo(1000 / 120 - 1000 / 150, 6) })
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
