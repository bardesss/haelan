import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { sourceParam } from '../controls/source.js'

// Mirrors the daily row apps/server/src/routes/v1/series.ts sends over the wire (personQuery's
// DailyPoint in packages/core/src/query/personQuery.ts), not a trimmed view of only what a
// sparkline reads today: source and updatedAtMs are on every point the server actually answers,
// and value is never null (the store's own read filters out rows with no value), so a type that
// hid those fields or widened value would be lying about a response nothing here composed.
export interface SeriesPoint {
  localDate: string
  value: number
  coverage: number | null
  source: string
  sourceMix: string | null
  updatedAtMs: number | null
  // True when the daily name itself had no row this date and the value is
  // DEVICE_ROLLED_EQUIVALENT's intraday mean standing in for it (personQuery.ts's own comment on
  // DailyPoint.filled). Required, not optional: an omitted field here would read as false through
  // every `point.filled` check downstream, which is exactly the silent "measured" claim this field
  // exists to rule out.
  filled: boolean
}

export interface MetricSeries {
  points: SeriesPoint[]
  // 'lttb' is the only method /series can produce (personQuery.series always thins with it), but
  // the union stays here rather than narrowing to the literal: it is Thinned<DailyPoint>['reduction']
  // in packages/core/src/query/downsample.ts, and narrowing a wire type to what one caller happens
  // to send is exactly the kind of drift that breaks silently when a second caller does not.
  reduction: { method: 'lttb' | 'minmax', from: number, to: number } | null
}

export interface SeriesRange {
  from: string
  to: string
  source: string
}

/**
 * Exported so the request shape can be asserted without mounting a component: the repeated
 * `metric` parameter is the entire reason `useSeries` takes an array rather than being called
 * once per metric (see the hook's own comment), and that only shows up in the query string.
 */
export function seriesPath(personId: string, metrics: string[], range: SeriesRange, agg: string): string {
  const params = new URLSearchParams()
  for (const metric of metrics) params.append('metric', metric)
  params.set('agg', agg)
  params.set('from', range.from)
  params.set('to', range.to)
  const source = sourceParam(range.source)
  if (source !== undefined) params.set('source', source)
  return `/api/v1/p/${personId}/series?${params.toString()}`
}

/**
 * One entry per calendar day in `dates`, carrying that day's value or null where the series has
 * no point for it, which is the shape every by-day chart on these pages draws from.
 *
 * `/series` omits a day with no row entirely, so a points array is "the days that reported" and its
 * positions mean nothing on their own. HeartRateRange and ActivityHeatmap have always been handed
 * dense arrays built this way from `rangeDates`; the sparklines were handed the points array
 * directly, which is what made an applied exclusion vanish rather than render. deriveDay deletes an
 * excluded metric's daily row, so the excluded day is exactly a day that no longer reports: with a
 * sparse array it had no position at all, its mark was dropped, its accessible table row was never
 * built, and the day the reader excluded silently left the chart. A gap has to be a position before
 * anything can be drawn at it.
 *
 * Values are read by date, never zipped by index, for the reason Dashboard.tsx's own heart rate
 * lookup gives: two series over the same range are not guaranteed to answer on the same days.
 */
export function denseSeries(
  dates: readonly string[], points: readonly SeriesPoint[],
): { labels: string[], values: (number | null)[] } {
  const byDate = new Map(points.map((point) => [point.localDate, point.value]))
  return { labels: [...dates], values: dates.map((date) => byDate.get(date) ?? null) }
}

/**
 * One request for every metric a page needs, because /series takes a repeated `metric` parameter
 * precisely so a dashboard does not open one connection per sparkline.
 *
 * personId comes from the session, never from a parameter: an account owns exactly one person,
 * and taking it here would let a caller ask for someone else's path.
 */
export function useSeries(
  metrics: string[], range: SeriesRange, agg = 'sum',
  // False asks for nothing: the year-over-year comparison's own reads (data/lastYear.ts) are
  // mounted on every page but only go out while the reader has the comparison switched on.
  enabled = true,
): UseQueryResult<Record<string, MetricSeries>> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'series', { metrics, ...range, agg }),
    // Without this the hook would request /api/v1/p/undefined/series on first render, which the
    // server answers 404 for and which then sits in the cache under a key naming no person.
    enabled: enabled && personId !== undefined,
    queryFn: () => apiGet<Record<string, MetricSeries>>(seriesPath(personId!, metrics, range, agg)),
  })
}
