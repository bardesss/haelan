import { useQuery } from '@tanstack/react-query'
import type { IntradayPoint } from './useIntraday.js'
import type { WorkoutSession } from './useSessions.js'
import { apiGet, ApiError } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'

// Mirrors the glance payload in packages/core/src/query/glance.ts, which the route sends whole - the same
// choice useAllTime.ts makes, and for the same reason: apps/web imports only @haelan/core's browser-safe
// subpaths, never its root export, because the root pulls better-sqlite3 and drizzle into the browser bundle.

// Mirrored and not read. The glance cards used to put a warning mark beside a column whose figures
// came from a quiet source; that warning moved to the status panel (StatusPanel.tsx), which says it
// once for the whole app. The fields stay in the payload, and so in this mirror of it, because the
// payload is the server's answer for every client of /glance, not only for this page.
export interface GlanceStaleSource {
  sourceId: string
  name: string
  lastReportedDate: string
  medianGapDays: number | null
}

export interface GlanceBaseline {
  center: number
  low: number
  high: number
  thin: boolean
}

export type GlanceStanding = 'within' | 'above' | 'below'

export interface GlanceStripDay {
  localDate: string
  value: number | null
  standing: GlanceStanding | null
}

export interface GlanceFigure {
  metric: string
  value: number | null
  unit: string
  baseline: GlanceBaseline | null
  asOfDate: string | null
  asOfMs: number | null
  partial: boolean
  staleSources: GlanceStaleSource[]
  strip: GlanceStripDay[]
  standing: GlanceStanding | null
}

export interface GlanceNightSegment {
  stage: string
  startMs: number
  endMs: number
}

export interface GlanceSleep {
  localDate: string
  sourceId: string
  startMs: number
  endMs: number
  startOffsetMinutes: number
  endOffsetMinutes: number
  segments: GlanceNightSegment[]
  asleep: GlanceFigure
  efficiency: GlanceFigure
  bedtime: GlanceFigure
  waketime: GlanceFigure
}

export type GlanceRecoveryBand = 'low' | 'below' | 'usual' | 'above' | 'high'

export interface GlanceRecovery {
  index: GlanceFigure
  band: GlanceRecoveryBand | null
  missing: string[] | null
  restingHeartRate: GlanceFigure
  hrv: GlanceFigure
  respiratoryRate: GlanceFigure | null
}

export interface GlanceStepsPace {
  center: number
  low: number
  high: number
  thin: boolean
  /** Today's own count, cut at the same minute as the band: what `standing` actually compares. */
  value: number
  atMs: number
  standing: 'ahead' | 'on' | 'behind' | null
}

export interface GlanceDay {
  steps: GlanceFigure
  stepsPace: GlanceStepsPace | null
  activeMinutes: GlanceFigure
  heartRate: { points: IntradayPoint[], asOfMs: number | null, staleSources: GlanceStaleSource[] }
  /** Today's workouts, oldest first, merged across sources: the Activity list's own row shape. */
  workouts: WorkoutSession[]
}

export interface GlanceWeekFigure {
  perDay: number
  days: number
  total: number
}

export interface GlanceWeek {
  steps: GlanceWeekFigure | null
  activeMinutes: GlanceWeekFigure | null
  asleep: GlanceWeekFigure | null
}

/** The nearest days with data before and after this glance's own day, up to and including today. Mirrors GlanceNav in packages/core/src/query/glance.ts. */
export interface GlanceNav {
  previous: string | null
  next: string | null
}

export interface Glance {
  today: string
  sleep: GlanceSleep | null
  recovery: GlanceRecovery
  day: GlanceDay
  week: GlanceWeek
  /** True when `today` names a day already over, rather than the day still running (M9c). */
  finished: boolean
  /** Where the day-navigation arrows on a finished day's page go. */
  nav: GlanceNav
}

/**
 * `day` is folded into the key rather than left off it, so a day someone opened, browsed away
 * from and came back to reads from cache instead of refetching - the same reason `useSeries` and
 * every other ranged read here keys on its own arguments. `'today'` in place of `null` keeps the
 * key one shape TanStack can hash consistently; `queryKeys.resource(personId, 'glance')` stays the
 * prefix so PR 371's `invalidateResource(..., 'glance')` (useAnnotations.ts), which matches on
 * `queryKey[2]` alone, still reaches every day's cached entry after a write.
 */
export function glanceKey(personId: string, day: string | null = null): readonly unknown[] {
  return [...queryKeys.resource(personId, 'glance'), day ?? 'today']
}

/** The `{ nearest }` a 404 answers with, when `day` names a gap in the archive. Read off the raw
 *  error body `apiSend` (client.ts) attaches to a thrown ApiError, since the server sends this
 *  shape bare rather than wrapped in the usual `{ error: {...} }` envelope. */
function nearestOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 404) return null
  const body = error.body as { nearest?: string | null } | undefined
  return typeof body?.nearest === 'string' ? body.nearest : null
}

/**
 * The glance: last night, today's recovery and today so far, as one read - or, given `day`, that
 * finished day's own answer instead (M9c day navigation).
 *
 * `day: null` means today, computed on the server in the request handler's timezone; a caller
 * asking for a specific day gets whatever the server built for that day. A day the archive has no
 * data for comes back as a 404 naming the `nearest` day that does, which this hook surfaces
 * separately from `error` so a caller can redirect there without having to unpack an ApiError.
 */
export function useGlance(day: string | null = null): {
  glance: Glance | undefined
  nearest: string | null
  isPending: boolean
  isError: boolean
  error: unknown
  refetch: () => unknown
} {
  const session = useSession()
  const personId = session.data?.personId
  const query = useQuery({
    queryKey: glanceKey(personId ?? '', day),
    // The same race useSeries and useSourceNames guard: asking before the session resolves would
    // cache an answer under a key naming no person.
    enabled: personId !== undefined,
    queryFn: () => apiGet<Glance>(day === null
      ? `/api/v1/p/${personId!}/glance`
      : `/api/v1/p/${personId!}/glance?day=${encodeURIComponent(day)}`),
  })

  return {
    glance: query.data,
    nearest: nearestOf(query.error),
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => { void query.refetch() },
  }
}
