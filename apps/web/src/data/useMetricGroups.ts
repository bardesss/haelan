import type { UseQueryResult } from '@tanstack/react-query'
import { useSeries } from './useSeries.js'
import type { MetricSeries, SeriesPoint, SeriesRange } from './useSeries.js'

/**
 * One agg, and every metric a page wants under it. `/series` takes exactly one `agg` for a whole
 * call (requireMetricAndAgg in packages/core/src/query/personQuery.ts checks every metric in the
 * call against that same value), and the catalogue rules out one call for a whole page:
 * heart_rate accepts min/mean/max/p50/count and neither sum nor last, resting_heart_rate is last
 * only. So a page groups its cards by which agg each one needs and issues one request per
 * distinct agg, which is fewer than one per card. That grouping is a page's own decision, not
 * something this hook can derive from a metric name: two pages can both read heart_rate and want
 * different aggs from it (a mean tile, a min/max/mean range chart), and the catalogue only says
 * which aggs a metric HAS rows under, never which of them a given card is asking to see. So this
 * hook takes groups already decided, formed with a page level `under()` filter against
 * @haelan/core/metrics the way Dashboard.tsx's REQUESTS/under pair does, rather than taking a flat
 * metric list and guessing an agg per metric itself.
 */
export interface MetricGroup {
  agg: string
  metrics: readonly string[]
}

export interface MetricGroups {
  /** The query that answers a given metric's group. Throws if `metric` is in none of `groups`. */
  queryFor: (metric: string) => UseQueryResult<Record<string, MetricSeries>>
  /** `metric`'s points, or the one shared EMPTY array below when its query has none. */
  pointsOf: (metric: string) => SeriesPoint[]
  /** Every group's query, in the same order as `groups`, for a caller that needs to await or
   *  retry all of them together rather than one metric at a time. */
  queries: readonly UseQueryResult<Record<string, MetricSeries>>[]
}

// Shared rather than a fresh [] per call: every chart on these pages keys its build callback on
// the arrays it is handed, and a new array identity on every render is read as "the data changed"
// by useChart, which disposes and re-initialises the underlying echarts instance. Frozen, not just
// documented as such: an M3d-1 comment called an array frozen while leaving it a plain mutable
// literal, and a consumer that later pushed into it would have corrupted every other metric's
// EMPTY at once, silently, since they are all the same array.
const EMPTY = Object.freeze([]) as never[]

function indexOfGroup(groups: readonly MetricGroup[], metric: string): number {
  const index = groups.findIndex((group) => group.metrics.includes(metric))
  if (index === -1) {
    throw new Error(`useMetricGroups: '${metric}' is not listed in any of the groups it was given`)
  }
  return index
}

/**
 * One `useSeries` call per group, and a lookup from a metric back to the query for its group.
 *
 * `groups` must be a module level constant in every caller (the shape Dashboard.tsx's
 * SUM_METRICS/LAST_METRICS/... split already is): the number and order of `useSeries` calls this
 * hook makes come directly from mapping over `groups`, never from anything a response contains, so
 * React sees the same hooks in the same order on every render regardless of which queries have
 * settled.
 */
export function useMetricGroups(groups: readonly MetricGroup[], range: SeriesRange): MetricGroups {
  const queries = groups.map((group) => useSeries([...group.metrics], range, group.agg))

  const queryFor = (metric: string): UseQueryResult<Record<string, MetricSeries>> =>
    queries[indexOfGroup(groups, metric)]!

  const pointsOf = (metric: string): SeriesPoint[] => queryFor(metric).data?.[metric]?.points ?? EMPTY

  return { queryFor, pointsOf, queries }
}
