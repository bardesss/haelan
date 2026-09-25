import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import type { DefaultName } from './useSourceNames.js'

// Mirrors AllTime in packages/core/src/query/allTime.ts, which the route sends whole - the same
// choice useSourceNames.ts and useMaintenance.ts make, and for the same reason: apps/web imports
// only @haelan/core's browser-safe subpaths, never its root export, because the root pulls
// better-sqlite3 and drizzle into the browser bundle.

export interface AllTimeSpan { from: string, to: string, days: number }

export interface MetricRecord {
  metric: string
  tier: 'merged' | 'provider'
  localDate: string
  value: number
  /** This metric's own first day, which is not the page's. */
  from: string
  days: number
  /** The device behind the record day, or null when no single one can be named. */
  sourceName: string | null
  /**
   * Set when `sourceName` is a known app's default, for sourceLabel to say it locally. Optional
   * because the demo's captured responses predate it until they are next regenerated, and a
   * missing one just means the server's English `sourceName` is printed as sent.
   */
  sourceDefaultName?: DefaultName | null
}

export interface SessionRecord {
  kind: 'longest' | 'furthest' | 'fastest-km'
  sessionId: string
  localDate: string
  exerciseType: string | null
  /** Milliseconds, millimetres or seconds, depending on `kind`. */
  value: number
}

export interface Milestone {
  kind: 'record' | 'count' | 'first' | 'run'
  localDate: string
  metric?: string
  count?: number
  days?: number
}

export interface AllTime {
  span: AllTimeSpan
  records: MetricRecord[]
  /** Only the session records the sessions actually support; may be empty. */
  sessionRecords: SessionRecord[]
  /** `from` and `days` are the step history's own window, not the span's. Null without steps. */
  eddington: { e: number, from: string, days: number } | null
  milestones: Milestone[]
}

export function allTimeKey(personId: string): readonly unknown[] {
  return queryKeys.resource(personId, 'all-time')
}

/**
 * Everything the all-time page shows, in one request.
 *
 * No range argument, unlike every other read in this app: these are the figures the range on
 * screen cannot answer, which is the whole reason the page exists.
 */
export function useAllTime(): {
  all: AllTime | undefined
  isPending: boolean
  isError: boolean
  error: unknown
  refetch: () => void
} {
  const session = useSession()
  const personId = session.data?.personId
  const query = useQuery({
    queryKey: allTimeKey(personId ?? ''),
    // The same race useSeries and useSourceNames guard: asking before the session resolves would
    // cache an answer under a key naming no person.
    enabled: personId !== undefined,
    queryFn: () => apiGet<AllTime>(`/api/v1/p/${personId!}/all-time`),
  })

  return {
    all: query.data,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => { void query.refetch() },
  }
}
