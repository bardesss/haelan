import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import type { PageFigure } from './useNightPage.js'
import type { DayLog } from './useNightPage.js'
import type { GlanceRecovery, GlanceStanding } from './useGlance.js'
import type { WorkoutSession } from './useSessions.js'
import type { SessionRecordKind } from './useAllTime.js'

// Mirrors the wire shape of packages/core/src/query/workoutPage.ts's WorkoutPage, after
// apps/server/src/routes/v1/detail.ts rounds it and adds `log`, field for field rather than
// imported: @haelan/core's root export pulls in better-sqlite3 and drizzle, which have no business
// in a browser bundle - the same reason useNightPage.ts carries its own copy of NightPage rather
// than importing core's.

/** packages/core/src/query/workoutPage.ts's own WorkoutFigureKey union. */
export type WorkoutFigureKey = 'pace' | 'speed' | 'distance' | 'movingTime' | 'elapsed' | 'averageHeartRate'
  | 'highestHeartRate' | 'cardioLoad' | 'banister' | 'calories' | 'steps' | 'activeZoneMinutes'
  | 'elevationGain' | 'hardZoneMinutes' | 'cadence' | 'strideLength' | 'groundContact'
  | 'verticalOscillation' | 'verticalRatio' | 'vo2max' | 'swimLengths'

/** One session on a figure's strip, judged against the figure's own usual (one band behind the
 *  whole strip, unlike a night figure's GlanceStripDay, which carries its day's own) so its dot
 *  takes its verdict's tone - workoutPage.ts's own WorkoutStripPoint. */
export interface WorkoutStripPoint {
  sessionId: string, localDate: string, value: number | null, standing: GlanceStanding | null, judged: 'better' | 'worse' | null
}

/** A workout figure: a PageFigure whose strip is WorkoutStripPoint rather than GlanceStripDay,
 *  plus the key it is filed under (workoutPage.ts's own WorkoutFigure). */
export interface WorkoutFigure extends Omit<PageFigure, 'strip'> { key: WorkoutFigureKey, strip: WorkoutStripPoint[] }

/** `better` of `of`: how many of the compared workouts this one beat on this measure
 *  (workoutComparison.ts's own ComparisonFacet). */
export interface ComparisonFacet { better: number, of: number }

export type ComparisonReason = 'no-type' | 'too-few'

/** One workout against recent ones of the same type (workoutComparison.ts's own WorkoutComparison). */
export interface WorkoutComparison {
  exerciseType: string | null
  of: number
  reason: ComparisonReason | null
  pace: ComparisonFacet | null
  heartRate: ComparisonFacet | null
  distance: ComparisonFacet | null
  cardioLoad: ComparisonFacet | null
}

/** One value a minute on the workout's own clock, each placed by its own `elapsedSeconds` (a
 *  minute with no value is simply not there), in `unit` (workoutThrough.ts's MinuteSeries). */
export interface MinuteSeries { unit: string, points: { elapsedSeconds: number, value: number }[] }

/** Pace, with its fastest minute: the lowest smoothed seconds per km and when it came (workoutThrough.ts's PaceSeries). */
export interface PaceSeries extends MinuteSeries { fastest: { secondsPerKm: number, elapsedSeconds: number } | null }

export interface RecordRef { value: number, sessionId: string, localDate: string }

/** A distance a category's fastest efforts are read over (fastestEfforts.ts's EFFORT_DISTANCES_BY_CATEGORY keys, e.g. '1k' or '20k'). */
export type EffortKey = string

/** One fastest effort beside the Records best of its kind and the best before this workout
 *  (workoutPage.ts's efforts entry): whole seconds, and whole metres along the route to where the
 *  stretch began. */
/** One fastest effort; `source` is where its time came from: the GPS route, or for a kilometre the watch's own split when that was quicker (workoutPage.ts's EffortSource). */
export interface WorkoutEffort { seconds: number, fromMeters: number, source: 'gps' | 'split', best: RecordRef | null, previousBest: RecordRef | null, isBest: boolean }

export interface WorkoutPageData {
  sessionId: string
  sourceId: string
  localDate: string
  exerciseType: string | null
  hero: WorkoutFigureKey
  nav: { previous: string | null, next: string | null }
  figures: Partial<Record<WorkoutFigureKey, WorkoutFigure>>
  comparison: WorkoutComparison
  previous: { sessionId: string, localDate: string, values: Partial<Record<'pace' | 'speed' | 'distance' | 'movingTime' | 'elapsed' | 'averageHeartRate' | 'cardioLoad', number>> } | null
  /** The category's Records bests (workoutPage.ts's best): one per kind the category keeps, null
   *  where none is held; `longest`, `furthest` and `most-climb` always present. Milliseconds for
   *  `longest`, whole metres for `furthest` and `most-climb`, whole seconds for each `fastest-*`. */
  best: Partial<Record<SessionRecordKind, RecordRef | null>> & Record<'longest' | 'furthest' | 'most-climb', RecordRef | null>
  day: { steps: PageFigure, activeMinutes: PageFigure, otherWorkouts: WorkoutSession[] }
  after: { night: { localDate: string, asleep: PageFigure, deep: PageFigure } | null, restingHeartRate: PageFigure | null }
  /** How far heart rate fell one and two minutes after the end, in whole bpm, each judged against
   *  the latest ten workouts of the type, and the minute means each fall is between (`readings`,
   *  whole bpm, null for a minute with no reading); null when neither minute had a reading. */
  heartRateRecovery: {
    oneMinute: PageFigure, twoMinutes: PageFigure
    readings: { endBpm: number, oneMinuteBpm: number | null, twoMinutesBpm: number | null }
    /** Earlier workouts of the type the usual is built from (up to ten). */
    history: number
  } | null
  /** The night ending on the workout's own date and that morning's recovery; null for each with no value. */
  before: { night: { localDate: string, asleep: PageFigure, deep: PageFigure } | null, recovery: GlanceRecovery | null, restingHeartRate: PageFigure | null }
  /** Pace (seconds per km, from the route) and cadence (steps per minute, from the workout's own
   *  device's steps) a minute at a time, whole numbers; null for each the workout cannot give. */
  through: { pace: PaceSeries | null, cadence: MinuteSeries | null }
  /** Whole seconds per km the second half of the automatic splits was faster than the first,
   *  negative when slower; null below two usable splits (workoutPage.ts's splitTrendOf). */
  splitTrend: { secondHalfFasterBySecondsPerKm: number } | null
  /** Where each heart rate zone above light begins, in whole bpm, from the provider's ceilings for
   *  the day (cardioLoad.ts's ZoneBounds); light has no floor to send. */
  zoneBounds: { moderateMin: number, vigorousMin: number, peakMin: number, max: number } | null
  /** This workout's time against the earlier times on the same route (workoutPage.ts's
   *  sameRouteOf): `time` is judged like any figure, lower being better, under the key it was
   *  compared on ('movingTime', or 'elapsed' when this workout recorded no moving time); `pace`
   *  the same against the earlier paces on the route, null without a pace of its own; `times` is
   *  how many times the route was done, this workout counted in, `since` the date of the oldest earlier one, `previous` the
   *  latest, its time in whole seconds. Null without a route or with no earlier workout on it. */
  sameRoute: {
    times: number, since: string, time: WorkoutFigure, pace: WorkoutFigure | null
    previous: { sessionId: string, localDate: string, seconds: number } | null
  } | null
  /** The fastest stretch over each of the category's effort distances inside the route (a run's
   *  1 km to marathon, a ride's 20 to 100 km), keyed by distance, in whole seconds, each beside the
   *  category's Records best (`isBest` when that best is this workout); null for a distance the
   *  route is shorter than, and null altogether without a route, for a category with no distances,
   *  or for a type that holds no speed record. */
  efforts: Record<EffortKey, WorkoutEffort | null> | null
  /** The quick log for the day this workout was done on (routes/v1/detail.ts: the workout's own localDate). */
  log: DayLog
}

/**
 * `queryKeys.resource(personId, 'workout')` as the prefix, `sessionId` appended, mirroring
 * `nightPageKey`'s own comment on why this is exported: so the key shape can be asserted without
 * mounting a component.
 */
export function workoutPageKey(personId: string, sessionId: string): readonly unknown[] {
  return [...queryKeys.resource(personId, 'workout'), sessionId]
}

/**
 * One workout's page: every figure on it judged against earlier sessions of the same type, beside
 * the day it was done on, the night after it, and the day's quick log, all from one request (GET
 * /p/:personId/workout/:sessionId).
 *
 * `sessionId` is `undefined` before the route parameter it comes from has resolved, the same half
 * of the enabled guard `useNightPage` already carries: without it an unresolved id would fire
 * `/workout/undefined` the moment the person alone was ready.
 */
export function useWorkoutPage(sessionId: string | undefined): UseQueryResult<WorkoutPageData> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: workoutPageKey(personId ?? '', sessionId ?? ''),
    enabled: personId !== undefined && sessionId !== undefined,
    queryFn: () => apiGet<WorkoutPageData>(`/api/v1/p/${personId!}/workout/${encodeURIComponent(sessionId!)}`),
  })
}
