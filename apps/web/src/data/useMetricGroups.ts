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
  /** Metrics actually put on the wire in this group's `useSeries` call. */
  metrics: readonly string[]
  /**
   * Metrics `queryFor`/`pointsOf` resolve to this group's query. Defaults to `metrics`, so the
   * common case (every named metric is both requested and answered) stays a single list.
   *
   * Separate from `metrics` because a card can legitimately name a metric the catalogue does not
   * offer at this agg: Dashboard.tsx's `under()` filters exactly that out of what gets requested,
   * so the group it would have ridden in still resolves the card to itself, finds no series under
   * its own name in the response, and renders that card's own empty state. Folding `covers` into
   * `metrics` would put the disallowed metric back on the wire and 500 every card riding along
   * with it (requireMetricAndAgg rejects the whole call the moment one metric in it lacks the
   * requested agg); leaving `covers` out entirely would make `queryFor`/`pointsOf` throw for a
   * metric that is a legitimate, if unanswerable-today, card, not a typo.
   */
  covers?: readonly string[]
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

// What a group answers for, not what it requests: `covers` when the caller gave one, `metrics`
// otherwise. A metric present here but absent from `metrics` was deliberately left off the wire
// (see MetricGroup's own doc comment), so it resolves to this group's query without ever having
// been asked for, and pointsOf then falls through to EMPTY for it the same way an ordinary metric
// with no rows does.
function covering(group: MetricGroup): readonly string[] {
  return group.covers ?? group.metrics
}

function indexOfGroup(groups: readonly MetricGroup[], metric: string): number {
  const index = groups.findIndex((group) => covering(group).includes(metric))
  if (index === -1) {
    // Not in any group's requested OR covered list: a typo or a card wired to a metric nobody
    // told this hook about, as opposed to a metric this hook knows about but the catalogue
    // disallows at this agg (that case is `covers` above, and resolves quietly). The two are
    // different failures and only one of them is a mistake worth failing loud for.
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
