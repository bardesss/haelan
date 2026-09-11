import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { sourceParam } from '../controls/source.js'
import { INTRADAY_POINTS } from './useIntraday.js'
import type { IntradayResult } from './useIntraday.js'

/**
 * Exported so the request shape, including the all sources sentinel's omission, can be asserted
 * without mounting a component. Mirrors intradayPath in useIntraday.ts for the same reason.
 *
 * The parameters are startMs and endMs, both inclusive. tier2.ts reads request.query.startMs and
 * request.query.endMs; a request sending `from` and `to`, which is what the date-range routes on
 * this API take, is missing both required parameters and 400s.
 *
 * INTRADAY_POINTS is reused rather than given a second constant of its own. Its reasoning holds
 * here unchanged: a constant rather than a figure derived from the chart's container width, so a
 * resize does not refetch and two cards at different widths do not cache separately.
 */
export function intradayWindowPath(
  personId: string,
  query: { metric: string, startMs: number, endMs: number, source: string },
): string {
  const params = new URLSearchParams({
    metric: query.metric,
    startMs: String(query.startMs),
    endMs: String(query.endMs),
    points: String(INTRADAY_POINTS),
  })
  const source = sourceParam(query.source)
  if (source !== undefined) params.set('source', source)
  return `/api/v1/p/${encodeURIComponent(personId)}/intraday/window?${params.toString()}`
}

/**
 * Intraday samples across a window rather than a local date: a workout, or a night that crosses
 * midnight and therefore has no single local date to ask for.
 *
 * `options.enabled` is separate from `query` for the same reason useIntraday keeps it separate:
 * whether a caller wants the request at all is not a fact about which window to fetch, and
 * folding it into `query` would put it in the cache key and cycle the entry every time it flipped.
 *
 * **This key is invisible to the only invalidation this app has, the same gap useWorkoutSession
 * records.** useAnnotations' overlapsAffected matches a cached query by reading a string `from`
 * and a string `to` out of its key params; this key carries `{ metric, startMs, endMs, source }`,
 * millisecond numbers rather than local dates, so no write ever matches it. A correction made on
 * the workout page - an excluded session, a corrected sample inside the window - leaves this
 * entry stale until its staleTime expires, while every date-keyed chart on the page updates at
 * once. M8a has no surface that writes, so this is recorded here and fixed in M8b, by the same
 * two options useWorkoutSession names: invalidate the resource explicitly after a session write,
 * or teach overlapsAffected to understand a millisecond window as a range.
 */
export function useIntradayWindow(
  query: { metric: string, startMs: number, endMs: number, source: string },
  options?: { enabled?: boolean },
): UseQueryResult<IntradayResult> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'intraday-window', query),
    // Without the personId half this requests /api/v1/p/undefined/intraday/window on first
    // render, which the server answers 404 for and which then sits in the cache under a key
    // naming no person.
    enabled: personId !== undefined && (options?.enabled ?? true),
    queryFn: () => apiGet<IntradayResult>(intradayWindowPath(personId!, query)),
  })
}
