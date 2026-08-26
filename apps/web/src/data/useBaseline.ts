import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { sourceParam } from '../controls/source.js'

// Matches packages/core/src/query/baseline.ts exactly: center, spread, n, thin, nothing more.
export interface Baseline {
  center: number
  spread: number
  n: number
  thin: boolean
}

/**
 * personId comes from the session, never a parameter, for the same reason useSeries does not
 * take one: an account owns exactly one person.
 *
 * agg is a fourth parameter rather than folded into a default the route assumes, because
 * apps/server/src/routes/v1/series.ts requires it (requireString throws on a missing agg) the
 * same way /series does; a hook that could not vary it would be one merge target ahead of a
 * caller that needs a metric aggregated some way other than sum.
 */
export function useBaseline(
  metric: string, on: string, source: string, agg = 'sum',
): UseQueryResult<{ baseline: Baseline | null }> {
  const session = useSession()
  const personId = session.data?.personId
  const params = new URLSearchParams({ metric, agg, on })
  const resolvedSource = sourceParam(source)
  if (resolvedSource !== undefined) params.set('source', resolvedSource)
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'baselines', { metric, on, source, agg }),
    enabled: personId !== undefined,
    queryFn: () => apiGet<{ baseline: Baseline | null }>(
      `/api/v1/p/${personId!}/baselines?${params.toString()}`,
    ),
  })
}
