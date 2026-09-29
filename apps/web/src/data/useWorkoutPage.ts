import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import type { PageFigure } from './useNightPage.js'
import type { DayLog } from './useNightPage.js'
import type { GlanceStanding } from './useGlance.js'
import type { WorkoutSession } from './useSessions.js'

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

export interface RecordRef { value: number, sessionId: string, localDate: string }

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
  best: { fastestKmSeconds: RecordRef | null, furthestMeters: RecordRef | null, longestMs: RecordRef | null }
  day: { steps: PageFigure, activeMinutes: PageFigure, otherWorkouts: WorkoutSession[] }
  after: { night: { localDate: string, asleep: PageFigure, deep: PageFigure } | null, restingHeartRate: PageFigure | null }
  /** Whole seconds per km the second half of the automatic splits was faster than the first,
   *  negative when slower; null below two usable splits (workoutPage.ts's splitTrendOf). */
  splitTrend: { secondHalfFasterBySecondsPerKm: number } | null
  /** Where each heart rate zone above light begins, in whole bpm, from the provider's ceilings for
   *  the day (cardioLoad.ts's ZoneBounds); light has no floor to send. */
  zoneBounds: { moderateMin: number, vigorousMin: number, peakMin: number, max: number } | null
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
