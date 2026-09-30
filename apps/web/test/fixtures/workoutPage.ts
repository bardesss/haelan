import type { GlanceBaseline, GlanceFigure, GlanceStanding } from '../../src/data/useGlance.js'
import type { PageFigure } from '../../src/data/useNightPage.js'
import type { MinuteSeries, PaceSeries, SpeedSeries, WorkoutFigure, WorkoutFigureKey, WorkoutPageData } from '../../src/data/useWorkoutPage.js'
import type { WorkoutSessionDetail } from '../../src/data/useSessions.js'

// One whole workout page (GET /p/:personId/workout/:sessionId) in the wire shape the route sends:
// packages/core/src/query/workoutPage.ts's WorkoutPage after apps/server/src/routes/v1/detail.ts's
// roundWorkoutPage (every figure at its own precision, `previous` and `best` whole numbers) plus
// the day's `log`. Every section is populated, so a test about one section starts from a page
// where every other section has something to draw.
//
// Synthetic numbers, shaped like the approved B mockup: a Friday evening run, 18:00 to 18:34 in
// Europe/Amsterdam (two hours ahead of UTC), 5.20 km at 5:24 /km.

export const WORKOUT_ID = 'run1'
export const WORKOUT_DATE = '2026-09-04'
export const PREVIOUS_ID = 'run0'
export const PREVIOUS_DATE = '2026-09-01'
/** The next workout of any type, which is what ‹ › step to (navOf: every type, by start). */
export const NEXT_ID = 'bike1'
export const NAV_PREVIOUS_ID = 'yoga1'

/** The ten sessions a strip covers, oldest first, this one last (workoutPage.ts's figuresOf). */
export const STRIP_DATES = [
  '2026-08-10', '2026-08-13', '2026-08-15', '2026-08-18', '2026-08-20',
  '2026-08-23', '2026-08-25', '2026-08-28', PREVIOUS_DATE, WORKOUT_DATE,
]
const STRIP_IDS = [...STRIP_DATES.slice(0, -2).map((_, i) => `run-${i + 2}`), PREVIOUS_ID, WORKOUT_ID]

const OFFSET = 120
const START = Date.UTC(2026, 8, 4, 16, 0)
const END = Date.UTC(2026, 8, 4, 16, 34)

function standingOf(value: number | null, band: GlanceBaseline | null): GlanceStanding | null {
  if (value === null || band === null || band.thin) return null
  return value < band.low ? 'below' : value > band.high ? 'above' : 'within'
}

// The server's own rule (pageFigure.ts's judge), applied to the fixture's own numbers so the
// fixture cannot carry a verdict that contradicts its standing. The page itself never does this.
function judgedOf(standing: GlanceStanding | null, direction: PageFigure['direction']): PageFigure['judged'] {
  if (standing === null || standing === 'within' || direction === 'neutral') return null
  return (standing === 'above') === (direction === 'up') ? 'better' : 'worse'
}

const band = (center: number, low: number, high: number): GlanceBaseline => ({ center, low, high, thin: false })

function figure(o: {
  key: WorkoutFigureKey, unit: string, precision?: number, direction?: PageFigure['direction'],
  value: number, baseline: GlanceBaseline | null, strip?: (number | null)[],
}): WorkoutFigure {
  const direction = o.direction ?? 'neutral'
  const standing = standingOf(o.value, o.baseline)
  // A figure with no strip of its own still carries this session as its one point, as figuresOf
  // always sends it; the nine before it are empty where those sessions had no reading.
  const values = o.strip ?? [...Array<null>(STRIP_DATES.length - 1).fill(null), o.value]
  return {
    key: o.key, metric: o.key, value: o.value, unit: o.unit, precision: o.precision ?? 0, direction,
    baseline: o.baseline, standing, judged: judgedOf(standing, direction),
    // Each point judged against the figure's one usual, as figuresOf judges it.
    strip: STRIP_DATES.map((localDate, i) => {
      const value = values[i] ?? null
      const pointStanding = standingOf(value, o.baseline)
      return { sessionId: STRIP_IDS[i]!, localDate, value, standing: pointStanding, judged: judgedOf(pointStanding, direction) }
    }),
  }
}

function dayFigure(metric: string, unit: string, direction: PageFigure['direction'], value: number, baseline: GlanceBaseline): PageFigure {
  const standing = standingOf(value, baseline)
  return { metric, value, unit, precision: 0, direction, baseline, standing, judged: judgedOf(standing, direction), strip: null }
}

/** A glance figure for the morning's recovery, as roundRecovery sends one: judged, no strip needed. */
function glanceFigure(metric: string, unit: string, value: number, baseline: GlanceBaseline, judged: GlanceFigure['judged']): GlanceFigure {
  return {
    metric, value, unit, baseline, asOfDate: WORKOUT_DATE, asOfMs: null, partial: false, staleSources: [], strip: [],
    standing: standingOf(value, baseline), judged,
  }
}

/**
 * Pace and cadence a minute at a time over the 34-minute run, placed by their own elapsed seconds:
 * pace (seconds per km) has no minutes 12 and 13, the pause, and cadence starts a minute later, as
 * wall-clock minutes do on a run that starts part way through one. Neither lines up by index.
 */
export const PACE_SERIES: PaceSeries = {
  unit: 'seconds_per_km',
  points: Array.from({ length: 34 }, (_, m) => m).filter((m) => m !== 12 && m !== 13)
    .map((m) => ({ elapsedSeconds: m * 60, value: m < 12 ? 332 : 318 })),
  // The first of the 318s, the minute after the pause.
  fastest: { secondsPerKm: 318, elapsedSeconds: 14 * 60 },
}
export const CADENCE_SERIES: MinuteSeries = {
  unit: 'steps_per_minute',
  points: Array.from({ length: 33 }, (_, m) => ({ elapsedSeconds: (m + 1) * 60, value: m < 5 ? 160 : 170 })),
}

/** The times on the same loop, this run counted in: eleven earlier ones, so the strip (the latest
 *  nine and this one) holds fewer than the count. */
export const ROUTE_TIMES = 12
export const ROUTE_PREVIOUS_ID = 'loop-8'
/** The oldest of the eleven, in May: before the strip's first date. */
export const ROUTE_SINCE = '2026-05-17'

/**
 * The time on the same loop as roundWorkoutPage sends it: moving time, judged against the earlier
 * times on the loop, lower being better. 28:04 under the usual 28:20 - 30:00, so faster, judged
 * better. Its strip's sessions are the loop's own, not the type's.
 */
function sameRouteFixture(): NonNullable<WorkoutPageData['sameRoute']> {
  const time = figure({
    key: 'movingTime', unit: 'seconds', direction: 'down', value: 1684, baseline: band(1740, 1700, 1800),
    strip: [1810, 1790, 1765, 1750, 1760, 1732, 1745, 1720, 1712, 1684],
  })
  // 5:24 /km under the loop's usual 5:29 - 5:43, so faster, judged better.
  const pace = figure({
    key: 'pace', unit: 'seconds_per_km', direction: 'down', value: 324, baseline: band(336, 329, 343),
    strip: [344, 341, 339, 338, 336, 333, 335, 331, 330, 324],
  })
  const loop = (f: WorkoutFigure): WorkoutFigure => ({
    ...f, strip: f.strip.map((point, i) => (i === f.strip.length - 1 ? point : { ...point, sessionId: `loop-${i}` })),
  })
  return {
    times: ROUTE_TIMES,
    since: ROUTE_SINCE,
    time: loop(time),
    rate: loop(pace),
    previous: { sessionId: ROUTE_PREVIOUS_ID, localDate: STRIP_DATES[8]!, seconds: 1712 },
  }
}

export function workoutPageFixture(): WorkoutPageData {
  return {
    sessionId: WORKOUT_ID,
    sourceId: 'watch',
    localDate: WORKOUT_DATE,
    exerciseType: 'RUNNING',
    hero: 'pace',
    nav: { previous: NAV_PREVIOUS_ID, next: NEXT_ID },
    figures: {
      pace: figure({ key: 'pace', unit: 'seconds_per_km', direction: 'down', value: 324, baseline: band(329, 322, 336), strip: [340, 335, 331, 333, 328, 326, 330, 327, 336, 324] }),
      distance: figure({ key: 'distance', unit: 'meters', value: 5200, baseline: band(5100, 4600, 5600), strip: [5000, 5100, 4800, 5300, 5000, 5500, 5100, 4900, 5000, 5200] }),
      movingTime: figure({ key: 'movingTime', unit: 'seconds', value: 1684, baseline: band(1680, 1500, 1860), strip: [1700, 1710, 1590, 1765, 1640, 1793, 1683, 1602, 1680, 1684] }),
      elapsed: figure({ key: 'elapsed', unit: 'seconds', value: 2040, baseline: band(1860, 1620, 2100) }),
      averageHeartRate: figure({ key: 'averageHeartRate', unit: 'bpm', value: 157, baseline: band(154, 150, 158), strip: [152, 155, 151, 156, 153, 154, 155, 152, 153, 157] }),
      // Read for the subject alone (workoutPage.ts's readingOf), so no usual at all.
      highestHeartRate: figure({ key: 'highestHeartRate', unit: 'bpm', value: 178, baseline: null }),
      cardioLoad: figure({ key: 'cardioLoad', unit: 'trimp', value: 71, baseline: band(62, 55, 70), strip: [58, 64, 55, 66, 60, 68, 61, 57, 62, 71] }),
      banister: figure({ key: 'banister', unit: 'trimp', value: 64, baseline: null }),
      calories: figure({ key: 'calories', unit: 'kcal', value: 412, baseline: band(385, 340, 430) }),
      steps: figure({ key: 'steps', unit: 'count', value: 5310, baseline: band(5150, 4700, 5600) }),
      activeZoneMinutes: figure({ key: 'activeZoneMinutes', unit: 'minutes', value: 43, baseline: band(37, 30, 45) }),
      elevationGain: figure({ key: 'elevationGain', unit: 'meters', value: 42, baseline: band(40, 20, 60) }),
      hardZoneMinutes: figure({ key: 'hardZoneMinutes', unit: 'minutes', value: 15, baseline: band(11, 8, 14) }),
      cadence: figure({ key: 'cadence', unit: 'steps_per_minute', value: 172, baseline: band(170, 166, 174) }),
      strideLength: figure({ key: 'strideLength', unit: 'meters', precision: 2, value: 1.09, baseline: band(1.06, 1.02, 1.1) }),
      groundContact: figure({ key: 'groundContact', unit: 'seconds', precision: 3, value: 0.248, baseline: band(0.251, 0.24, 0.262) }),
      verticalOscillation: figure({ key: 'verticalOscillation', unit: 'meters', precision: 3, value: 0.089, baseline: band(0.09, 0.084, 0.096) }),
      verticalRatio: figure({ key: 'verticalRatio', unit: 'ratio', precision: 1, value: 8.2, baseline: band(8.4, 7.9, 8.9) }),
      vo2max: figure({ key: 'vo2max', unit: 'ml_per_kg_min', direction: 'up', value: 46, baseline: band(45, 44, 46), strip: [44, 44, 44, 45, 45, 45, 45, 46, 45, 46] }),
    },
    comparison: {
      exerciseType: 'RUNNING', of: 20, reason: null,
      heartRate: { better: 4, of: 20 }, distance: { better: 12, of: 20 }, cardioLoad: { better: 18, of: 20 },
    },
    rank: { better: 17, of: 20 },
    previous: { sessionId: PREVIOUS_ID, localDate: PREVIOUS_DATE, values: { pace: 336, distance: 5000, averageHeartRate: 153, cardioLoad: 62 } },
    best: {
      longest: { value: 3_904_000, sessionId: 'run-may', localDate: '2026-05-10' },
      furthest: { value: 10400, sessionId: 'run-may', localDate: '2026-05-10' },
      'most-climb': null,
      'fastest-1k': { value: 290, sessionId: 'run-june', localDate: '2026-06-14' },
      'fastest-mile': { value: 471, sessionId: 'run-june', localDate: '2026-06-14' },
      'fastest-5k': { value: 1602, sessionId: WORKOUT_ID, localDate: WORKOUT_DATE },
      'fastest-10k': null, 'fastest-half': null, 'fastest-marathon': null,
    },
    day: {
      steps: dayFigure('steps', 'count', 'up', 12880, band(8250, 6000, 10500)),
      activeMinutes: dayFigure('active_minutes', 'minutes', 'up', 61, band(42, 25, 60)),
      otherWorkouts: [],
    },
    after: {
      night: {
        localDate: '2026-09-05',
        asleep: dayFigure('sleep_asleep_minutes', 'minutes', 'up', 432, band(400, 330, 470)),
        deep: dayFigure('sleep_deep_minutes', 'minutes', 'up', 82, band(85, 70, 100)),
      },
      restingHeartRate: dayFigure('resting_heart_rate', 'bpm', 'down', 55, band(54, 51, 57)),
    },
    // The mockup's 24 and 41 bpm, rounded as the route sends them: the first within its usual, the
    // second above it, judged better, since a larger fall is a quicker recovery.
    heartRateRecovery: {
      oneMinute: dayFigure('heart_rate_recovery_1min', 'bpm', 'up', 25, band(22, 18, 27)),
      twoMinutes: dayFigure('heart_rate_recovery_2min', 'bpm', 'up', 41, band(34, 30, 38)),
      readings: { endBpm: 146, oneMinuteBpm: 121, twoMinutesBpm: 105 },
      history: 10,
    },
    // The night ending on the workout's own date, and that morning.
    before: {
      night: {
        localDate: WORKOUT_DATE,
        asleep: dayFigure('sleep_asleep_minutes', 'minutes', 'up', 372, band(400, 330, 470)),
        deep: dayFigure('sleep_deep_minutes', 'minutes', 'up', 64, band(85, 70, 100)),
      },
      recovery: {
        index: glanceFigure('recovery_index', 'count', 58, band(63, 52, 74), null),
        band: 'usual', missing: null,
        restingHeartRate: glanceFigure('resting_heart_rate', 'bpm', 53, band(54, 51, 57), null),
        hrv: glanceFigure('hrv', 'milliseconds', 41, band(40, 34, 46), null),
        respiratoryRate: null,
      },
      restingHeartRate: dayFigure('resting_heart_rate', 'bpm', 'down', 53, band(54, 51, 57)),
    },
    through: { pace: PACE_SERIES, speed: null, cadence: CADENCE_SERIES },
    // The mockup's negative split, and the provider's zone ceilings for the day.
    splitTrend: { secondHalfFasterBySecondsPerKm: 22 },
    zoneBounds: { moderateMin: 113, vigorousMin: 137, peakMin: 162, max: 187 },
    sameRoute: sameRouteFixture(),
    // The fastest stretches inside the run, whole seconds, each starting whole metres in: the
    // kilometre and the mile short of the June bests, the 5 km this run's own, 12 s quicker than
    // the August best it beat.
    efforts: {
      '1k': {
        seconds: 296, fromMeters: 3400, source: 'gps', isBest: false,
        best: { value: 290, sessionId: 'run-june', localDate: '2026-06-14' },
        previousBest: { value: 290, sessionId: 'run-june', localDate: '2026-06-14' },
      },
      mile: {
        seconds: 479, fromMeters: 3200, source: 'gps', isBest: false,
        best: { value: 471, sessionId: 'run-june', localDate: '2026-06-14' },
        previousBest: { value: 471, sessionId: 'run-june', localDate: '2026-06-14' },
      },
      '5k': {
        seconds: 1602, fromMeters: 180, source: 'gps', isBest: true,
        best: { value: 1602, sessionId: WORKOUT_ID, localDate: WORKOUT_DATE },
        previousBest: { value: 1614, sessionId: 'run-august', localDate: '2026-08-15' },
      },
      '10k': null, half: null, marathon: null,
    },
    log: {
      presets: ['illness', 'travel', 'alcohol', 'medication', 'injury', 'caffeine'],
      mood: 5,
      counts: { caffeine: 1 },
      note: null,
      today: '2026-09-07',
    },
  }
}

/**
 * A strength session as the server sends one: no distance, so no pace and no speed, moving time
 * as its hero, a heart rate and a load, nothing of the same type before it (a first session: a
 * thin usual, no comparison) and no Records best, since the Records page keeps none for a type
 * with no distance and no kilometres.
 */
export function strengthPageFixture(): WorkoutPageData {
  const page = workoutPageFixture()
  const thin = (center: number): GlanceBaseline => ({ center, low: center, high: center, thin: true })
  return {
    ...page,
    exerciseType: 'WEIGHTLIFTING',
    hero: 'movingTime',
    figures: {
      movingTime: figure({ key: 'movingTime', unit: 'seconds', value: 2700, baseline: thin(2700) }),
      elapsed: figure({ key: 'elapsed', unit: 'seconds', value: 2880, baseline: thin(2880) }),
      averageHeartRate: figure({ key: 'averageHeartRate', unit: 'bpm', value: 112, baseline: thin(112) }),
      calories: figure({ key: 'calories', unit: 'kcal', value: 240, baseline: thin(240) }),
    },
    comparison: { exerciseType: 'WEIGHTLIFTING', of: 0, reason: 'too-few', heartRate: null, distance: null, cardioLoad: null },
    rank: null,
    previous: null,
    best: { longest: null, furthest: null, 'most-climb': null },
    splitTrend: null,
    // No route and no steps from the gym: nothing a minute at a time beside the heart rate.
    through: { pace: null, speed: null, cadence: null },
    // No route, so no loop to set it against and no stretch to time.
    sameRoute: null,
    efforts: null,
  }
}

/**
 * A ride's speed a minute at a time, in metres per second at the speed figure's two decimals: 8.33
 * (30.0 km/h) for twelve minutes, the pause, then 9.00 (32.4 km/h), its highest the first of those.
 */
export const SPEED_SERIES: SpeedSeries = {
  unit: 'meters_per_second',
  points: Array.from({ length: 34 }, (_, m) => m).filter((m) => m !== 12 && m !== 13)
    .map((m) => ({ elapsedSeconds: m * 60, value: m < 12 ? 8.33 : 9 })),
  fastest: { metersPerSecond: 9, elapsedSeconds: 14 * 60 },
}

/**
 * A road ride as the server sends one (workoutPage.ts per sport): speed its hero, 7.6 m/s (27.4
 * km/h) inside its usual; no pace, no cadence and no running form, since a ride has none; the
 * previous ride's speed 7.38 m/s (26.6 km/h), so 0.8 km/h slower than this one; its speed through
 * the workout in place of pace; a split trend in metres per second; and its speed on the loop.
 */
export function ridePageFixture(): WorkoutPageData {
  const page = workoutPageFixture()
  const speed = figure({
    key: 'speed', unit: 'meters_per_second', precision: 2, direction: 'up', value: 7.6, baseline: band(7.3, 6.9, 7.8),
    strip: [7.1, 7.2, 7.0, 7.4, 7.3, 7.5, 7.2, 7.1, 7.38, 7.6],
  })
  const { pace: _pace, cadence: _cadence, strideLength: _s, groundContact: _g, verticalOscillation: _o, verticalRatio: _r, vo2max: _v, ...rest } = page.figures
  const same = page.sameRoute!
  return {
    ...page,
    exerciseType: 'BIKING',
    hero: 'speed',
    figures: { ...rest, speed, distance: figure({ key: 'distance', unit: 'meters', value: 30_000, baseline: band(28_000, 24_000, 32_000) }) },
    comparison: { ...page.comparison, exerciseType: 'BIKING' },
    rank: { better: 12, of: 20 },
    previous: { sessionId: PREVIOUS_ID, localDate: PREVIOUS_DATE, values: { speed: 7.38, distance: 28_000, averageHeartRate: 141, cardioLoad: 60 } },
    best: {
      longest: { value: 9_000_000, sessionId: 'ride-may', localDate: '2026-05-10' },
      furthest: { value: 80_000, sessionId: 'ride-may', localDate: '2026-05-10' },
      'most-climb': null, 'fastest-20k': null, 'fastest-40k': null, 'fastest-100k': null,
    },
    through: { pace: null, speed: SPEED_SERIES, cadence: null },
    // 0.33 m/s is 1.188 km/h, printed 1.2.
    splitTrend: { secondHalfFasterByMetersPerSecond: 0.33 },
    sameRoute: { ...same, rate: { ...speed, strip: speed.strip.map((point, i) => (i === speed.strip.length - 1 ? point : { ...point, sessionId: `loop-${i}` })) } },
    efforts: null,
  }
}

/** The ride's own `/sessions/:id` answer: its three kilometres at 30.0, 36.0 and 24.0 km/h. */
export function rideSessionFixture(): WorkoutSessionDetail {
  const session = workoutSessionFixture()
  return {
    ...session,
    attrs: { exerciseType: 'BIKING', activeDuration: '4000s', metricsSummary: { distanceMillimeters: 30_000_000 } },
    route: ROUTE_FIXTURE,
    autoSplits: [120, 100, 150].map((pace, i) => ({
      startMs: START + i * 150_000, endMs: START + (i + 1) * 150_000, splitType: 'DISTANCE',
      activeDurationSeconds: pace, distanceMeters: 1000, paceSecondsPerKm: pace,
      averageHeartRateBpm: 140 + i, averageHeartRateBpmSource: 'provider' as const,
    })),
  }
}

/**
 * A pool swim as the server sends one: its pace per 100 m the hero, 2:05 inside its usual; no pace
 * per km, no climb; the previous swim 2:09 a 100 m, so 4 s/100 m slower; no route, so nothing
 * through the workout, no loop and no stretches.
 */
export function swimPageFixture(): WorkoutPageData {
  const page = workoutPageFixture()
  return {
    ...page,
    exerciseType: 'SWIMMING_POOL',
    hero: 'swimPace',
    figures: {
      swimPace: figure({ key: 'swimPace', unit: 'seconds_per_100m', direction: 'down', value: 125, baseline: band(128, 122, 134), strip: [131, 129, 133, 127, 128, 130, 126, 128, 129, 125] }),
      distance: figure({ key: 'distance', unit: 'meters', value: 1500, baseline: band(1400, 1200, 1600) }),
      movingTime: figure({ key: 'movingTime', unit: 'seconds', value: 1875, baseline: band(1800, 1600, 2000) }),
      averageHeartRate: page.figures.averageHeartRate!,
    },
    comparison: { ...page.comparison, exerciseType: 'SWIMMING_POOL' },
    rank: { better: 20, of: 20 },
    previous: { sessionId: PREVIOUS_ID, localDate: PREVIOUS_DATE, values: { swimPace: 129, distance: 1400, averageHeartRate: 150 } },
    best: {
      longest: { value: 3_000_000, sessionId: 'swim-may', localDate: '2026-05-10' },
      furthest: { value: 2000, sessionId: 'swim-may', localDate: '2026-05-10' },
      'most-climb': null,
    },
    through: { pace: null, speed: null, cadence: null },
    splitTrend: null,
    sameRoute: null,
    efforts: null,
  }
}

/** The `/sessions/:id` answer beside the page: the workout's clock times, its note and its source. */
export function workoutSessionFixture(): WorkoutSessionDetail {
  return {
    id: WORKOUT_ID, sourceId: 'watch',
    startMs: START, endMs: END, startOffsetMinutes: OFFSET, endOffsetMinutes: OFFSET, localDate: WORKOUT_DATE,
    attrs: {
      exerciseType: 'RUNNING', displayName: 'Running', activeDuration: '1684s',
      notes: 'Easy start, pushed the last kilometre.',
      metricsSummary: { caloriesKcal: 412, distanceMillimeters: 5_200_000 },
    },
    excluded: false, excludeReason: null, sources: ['watch'], alternateIds: [],
    cardioLoad: null, autoSplits: [], laps: [], route: [],
  }
}

/** The mockup's six automatic splits, 5:32 to a last 0.2 km at 4:51, the last heart rate filled
 *  from the trace, as `/sessions/:id` sends them (splitHeartRate.ts's FilledSplit). */
export const SPLITS_FIXTURE: WorkoutSessionDetail['autoSplits'] = [
  [1000, 332, 146], [1000, 324, 152], [1000, 326, 156], [1000, 315, 163], [1000, 302, 171], [200, 291, 176],
].map(([distance, pace, bpm], i) => ({
  startMs: START + i * 330_000, endMs: START + (i + 1) * 330_000, splitType: 'DISTANCE',
  activeDurationSeconds: (pace! * distance!) / 1000, distanceMeters: distance!, paceSecondsPerKm: pace!,
  averageHeartRateBpm: bpm!, averageHeartRateBpmSource: i === 5 ? 'trace' as const : 'provider' as const,
}))

/** A small loop with a climb in the middle: four fixes, three of them with an altitude. */
export const ROUTE_FIXTURE: WorkoutSessionDetail['route'] = [
  { atMs: START, latitude: 52.1, longitude: 4.3, altitudeMetres: 2, horizontalAccuracyMetres: null, verticalAccuracyMetres: null },
  { atMs: START + 600_000, latitude: 52.11, longitude: 4.31, altitudeMetres: 22, horizontalAccuracyMetres: null, verticalAccuracyMetres: null },
  { atMs: START + 1_200_000, latitude: 52.1, longitude: 4.32, altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null },
  { atMs: START + 1_800_000, latitude: 52.1, longitude: 4.3, altitudeMetres: 4, horizontalAccuracyMetres: null, verticalAccuracyMetres: null },
]

/** The strength session's own `/sessions/:id` answer. */
export function strengthSessionFixture(): WorkoutSessionDetail {
  const session = workoutSessionFixture()
  return { ...session, attrs: { exerciseType: 'WEIGHTLIFTING', activeDuration: '2700s' } }
}
