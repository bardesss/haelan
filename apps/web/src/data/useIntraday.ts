import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { sourceParam } from '../controls/source.js'

// Mirrors packages/core/src/query/intraday.ts's IntradayPoint as sent by
// apps/server/src/routes/v1/tier2.ts's GET /p/:personId/intraday. min, mean and max are rounded at
// the route boundary to the metric's own precision, not here and not in the reader. n and excluded
// pass through that boundary untouched (tier2.ts only rounds the three value fields), so they carry
// the same meaning core's own comment on IntradayPoint gives: n is how many readings this point
// combines (always 1 for heart rate, since it is stored downsampled to the minute, one reading
// written as three rows), and it is what IntradayHeartRate's Correct guard reads to decide whether
// the clicked point names one instant a sample override can actually point at. excluded is whether
// a sample-scope exclusion already names the row behind this point.
export interface IntradayPoint {
  sourceId: string
  utcMs: number
  min: number | null
  mean: number | null
  max: number | null
  n: number
  excluded: boolean
}

export interface IntradayResult {
  points: IntradayPoint[]
  // Null when nothing was thinned and the response holds the full series for this day. An object
  // with method, from (pre-thin count), and to (post-thin count) when the series exceeded the
  // request's points budget. A consumer can distinguish a complete 400 point series from a
  // thinned one standing in for 130,000; this distinction drives whether a basis line anchors on
  // the visible points (full series) or the original count (thinned).
  reduction: { method: 'lttb' | 'minmax', from: number, to: number } | null
}

/**
 * One point per two minutes across a 1440 minute day. A constant rather than a figure derived from
 * the chart's container width: a width derived target puts layout into the request key, so a
 * resize refetches and two cards at different widths cache separately. The thinning is not
 * optional at this volume, which is measured rather than assumed: one household's seven months
 * holds 1,200,416 heart rate samples, about 5,700 a day, or one every fifteen seconds.
 */
export const INTRADAY_POINTS = 720

/**
 * Exported so the request shape can be asserted without mounting a component, the same reason
 * nightsPath and seriesPath are.
 *
 * The parameter is `date`. tier2.ts reads request.query.date; a request sending localDate is
 * missing a required parameter and 400s.
 */
export function intradayPath(
  personId: string, query: { metric: string, date: string, source: string },
): string {
  const params = new URLSearchParams({
    metric: query.metric, date: query.date, points: String(INTRADAY_POINTS),
  })
  const source = sourceParam(query.source)
  if (source !== undefined) params.set('source', source)
  return `/api/v1/p/${personId}/intraday?${params.toString()}`
}

export function useIntraday(
  query: { metric: string, date: string, source: string },
  // Separate from `query` rather than a fourth field on it: `enabled` is a fact about whether the
  // caller wants this request at all (Dashboard.tsx's heart rate card only wants it on the Day
  // tab), not a fact about which day's intraday points to fetch, and folding it into `query` would
  // put it in the query key too, cycling the cache entry on every tab flip for no reason.
  // Defaults to true so every existing single-argument call keeps requesting unconditionally.
  options?: { enabled?: boolean },
): UseQueryResult<IntradayResult> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'intraday', query),
    // Without the personId half, this hook requests /api/v1/p/undefined/intraday on first render,
    // which the server answers 404 for and which then sits in the cache under a key naming no
    // person.
    enabled: personId !== undefined && (options?.enabled ?? true),
    queryFn: () => apiGet<IntradayResult>(intradayPath(personId!, query)),
  })
}
