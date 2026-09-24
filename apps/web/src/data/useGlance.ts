import { useQuery } from '@tanstack/react-query'
import type { IntradayPoint } from './useIntraday.js'
import type { WorkoutSession } from './useSessions.js'
import { apiGet } from '../api/client.js'
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

export interface Glance {
  today: string
  sleep: GlanceSleep | null
  recovery: GlanceRecovery
  day: GlanceDay
  week: GlanceWeek
}

export function glanceKey(personId: string): readonly unknown[] {
  return queryKeys.resource(personId, 'glance')
}

/**
 * The glance: last night, today's recovery and today so far, as one read.
 *
 * No range argument, unlike most other reads in this app: the glance is the glance for today only,
 * and today is computed on the server in the request handler's timezone.
 */
export function useGlance(): {
  glance: Glance | undefined
  isPending: boolean
  isError: boolean
  error: unknown
  refetch: () => unknown
} {
  const session = useSession()
  const personId = session.data?.personId
  const query = useQuery({
    queryKey: glanceKey(personId ?? ''),
    // The same race useSeries and useSourceNames guard: asking before the session resolves would
    // cache an answer under a key naming no person.
    enabled: personId !== undefined,
    queryFn: () => apiGet<Glance>(`/api/v1/p/${personId!}/glance`),
  })

  return {
    glance: query.data,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => { void query.refetch() },
  }
}
