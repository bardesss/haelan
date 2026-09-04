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
