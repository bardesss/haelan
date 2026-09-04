import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { sourceParam } from '../controls/source.js'

// Task 2's reader is the only thing allowed to look inside attrs.
export interface WorkoutSession {
  id: string
  sourceId: string
  startMs: number
  endMs: number
  startOffsetMinutes: number
  endOffsetMinutes: number
  localDate: string
  attrs: unknown
}

/**
 * Exported so the request shape, including the all sources sentinel's omission, can be asserted
 * without mounting a component. Mirrors nightsPath in useNights.ts for the same reason.
 *
 * The route is GET /api/v1/p/:personId/sessions taking kind (required, 'exercise' or 'sleep'),
 * from, to, limit, cursor and source, and answering { items, cursor }. source routes through
 * sourceParam so the all sources sentinel is omitted rather than sent literally, which is the
 * defect the M3 phase review found in exportPathFor: the server knows no source called 'all' and
 * every request 400s at the default view.
 *
 * 'merged' is a real row value on the tier 1 `daily` rollup (MERGED_SOURCE), which is why
 * useSeries and useBaseline can send it as-is. Tier 2 reads (this route) go straight to the
 * `sessions` table in packages/core/src/query/sessions.ts, which carries only per-device source
 * ids; personQuery.sessions calls requireSource with an empty alsoAllowed array
 * (packages/core/src/query/personQuery.ts line 274), so a literal 'merged' here is not a known
 * source and the request 400s (ConfigError). sourceParam only omits the all sources sentinel, so
 * it does not prevent 'merged' from being sent. Its one caller, SessionList, is handed a source
 * already run through resolveSource (Activity.tsx builds `resolved` from it), and resolveSource
 * only ever answers ALL_SOURCES or a source id read out of a sourceMix, which names devices and
 * never 'merged'. A future caller that skips that step and passes an unresolved source straight
 * through would not be caught here.
 */
export function sessionsPath(
  personId: string,
  query: { kind: 'exercise' | 'sleep', from: string, to: string, source: string },
): string {
  const params = new URLSearchParams({ kind: query.kind, from: query.from, to: query.to })
  const source = sourceParam(query.source)
  if (source !== undefined) params.set('source', source)
  return `/api/v1/p/${personId}/sessions?${params.toString()}`
}

export function useSessions(
  query: { kind: 'exercise' | 'sleep', from: string, to: string, source: string },
): UseQueryResult<{ items: WorkoutSession[], cursor: string | null }> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'sessions', query),
    // Without this the hook requests /api/v1/p/undefined/sessions on first render, which the
    // server answers 404 for and which then sits in the cache under a key naming no person.
    enabled: personId !== undefined,
    queryFn: () => apiGet<{ items: WorkoutSession[], cursor: string | null }>(sessionsPath(personId!, query)),
  })
}
