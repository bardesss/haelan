import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { sourceParam } from '../controls/source.js'

// Mirrors packages/core/src/query/trend.ts's TrendPoint as wrapped by
// apps/server/src/routes/v1/series.ts's GET /p/:personId/trend. Rounded to the metric's own
// catalogue precision at the route boundary, not here and not in the reader, the same split
// useIntraday.ts's own IntradayPoint comment states for its min/mean/max.
export interface TrendPoint {
  localDate: string
  value: number | null
}

export interface TrendResult {
  points: TrendPoint[]
}

/**
 * Exported so the request shape can be asserted without mounting a component, the same reason
 * intradayPath and seriesPath are.
 */
export function trendPath(
  personId: string, query: { metric: string, agg: string, from: string, to: string, source: string },
): string {
  const params = new URLSearchParams({
    metric: query.metric, agg: query.agg, from: query.from, to: query.to,
  })
  const source = sourceParam(query.source)
  if (source !== undefined) params.set('source', source)
  return `/api/v1/p/${personId}/trend?${params.toString()}`
}

export function useTrend(
  query: { metric: string, agg: string, from: string, to: string, source: string },
): UseQueryResult<TrendResult> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'trend', query),
    // Without the personId half, this hook requests /api/v1/p/undefined/trend on first render,
    // which the server answers 404 for and which then sits in the cache under a key naming no
    // person.
    enabled: personId !== undefined,
    queryFn: () => apiGet<TrendResult>(trendPath(personId!, query)),
  })
}
