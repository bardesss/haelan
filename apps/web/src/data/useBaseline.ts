import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { baselineWindow } from '@haelan/core/baseline-window'
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
 * Exported so the request shape, including the all sources sentinel's omission, can be asserted
 * without mounting a component. Mirrors seriesPath in useSeries.ts for the same reason.
 */
export function baselinePath(personId: string, metric: string, on: string, source: string, agg: string): string {
  const params = new URLSearchParams({ metric, agg, on })
  const resolvedSource = sourceParam(source)
  if (resolvedSource !== undefined) params.set('source', resolvedSource)
  return `/api/v1/p/${personId}/baselines?${params.toString()}`
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
  // The key carries the window baselineWindow(on) actually reads (sixty days ending the day
  // before `on`, packages/core/src/query/baseline.ts), not `on` itself: overlapsAffected
  // (useAnnotations.ts) invalidates a cached ranged read by comparing its own from/to against the
  // range an override just changed, and a key naming only the anchor date gives it nothing to
  // compare, so an exclusion inside the window never invalidated the baseline it fed. Two
  // different anchors never collide here either, since shiftLocalDate is one-to-one and `to` is
  // always `on` shifted by exactly one day.
  const { from, to } = baselineWindow(on)
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'baselines', { metric, from, to, source, agg }),
    enabled: personId !== undefined,
    queryFn: () => apiGet<{ baseline: Baseline | null }>(baselinePath(personId!, metric, on, source, agg)),
  })
}
