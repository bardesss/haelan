import type { GlanceBaseline, GlanceStanding } from '../../src/data/useGlance.js'
import type { PageFigure } from '../../src/data/useNightPage.js'
import type { WorkoutFigure, WorkoutFigureKey, WorkoutPageData } from '../../src/data/useWorkoutPage.js'
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
    strip: STRIP_DATES.map((localDate, i) => ({ sessionId: STRIP_IDS[i]!, localDate, value: values[i] ?? null })),
  }
}

function dayFigure(metric: string, unit: string, direction: PageFigure['direction'], value: number, baseline: GlanceBaseline): PageFigure {
  const standing = standingOf(value, baseline)
  return { metric, value, unit, precision: 0, direction, baseline, standing, judged: judgedOf(standing, direction), strip: null }
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
      vo2max: figure({ key: 'vo2max', unit: 'ml_per_kg_min', direction: 'up', value: 46, baseline: band(45, 44, 46) }),
    },
    comparison: {
      exerciseType: 'RUNNING', of: 20, reason: null,
      pace: { better: 17, of: 20 }, heartRate: { better: 4, of: 20 }, distance: { better: 12, of: 20 }, cardioLoad: { better: 18, of: 20 },
    },
    previous: { sessionId: PREVIOUS_ID, localDate: PREVIOUS_DATE, values: { pace: 336, distance: 5000, averageHeartRate: 153, cardioLoad: 62 } },
    best: {
      fastestKmSeconds: { value: 290, sessionId: 'run-june', localDate: '2026-06-14' },
      furthestMeters: { value: 10400, sessionId: 'run-may', localDate: '2026-05-10' },
      longestMs: { value: 3_904_000, sessionId: 'run-may', localDate: '2026-05-10' },
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
    comparison: { exerciseType: 'WEIGHTLIFTING', of: 0, reason: 'too-few', pace: null, heartRate: null, distance: null, cardioLoad: null },
    previous: null,
    best: { fastestKmSeconds: null, furthestMeters: null, longestMs: null },
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

/** The strength session's own `/sessions/:id` answer. */
export function strengthSessionFixture(): WorkoutSessionDetail {
  const session = workoutSessionFixture()
  return { ...session, attrs: { exerciseType: 'WEIGHTLIFTING', activeDuration: '2700s' } }
}
