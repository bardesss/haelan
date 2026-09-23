import { useMemo } from 'react'
import { useMetricGroups } from './useMetricGroups.js'
import type { MetricGroup } from './useMetricGroups.js'
import type { SeriesPoint, SeriesRange } from './useSeries.js'

/**
 * The same calendar date a year earlier, or null for a leap day, which has no partner. A null is
 * a gap on the comparison line, never a borrowed neighbour: 28 February drawn as last year's 29th
 * would put a real reading on a day it was not taken.
 */
export function yearEarlier(date: string): string | null {
  const year = Number(date.slice(0, 4)) - 1
  const monthDay = date.slice(5)
  if (monthDay === '02-29') return null
  return `${String(year).padStart(4, '0')}-${monthDay}`
}

/**
 * The range a year earlier. A leap-day end falls back to the 28th, because a range needs an end
 * even when the day it would name did not exist; the alignment above is what keeps that 28th off
 * this year's 29th.
 */
export function yearEarlierRange(range: SeriesRange): SeriesRange {
  const shift = (date: string) => yearEarlier(date) ?? `${Number(date.slice(0, 4)) - 1}-02-28`
  return { ...range, from: shift(range.from), to: shift(range.to) }
}

/** One entry per label, carrying the reading from the same date a year earlier, or null. */
export function alignYearEarlier(labels: readonly string[], points: readonly SeriesPoint[]): (number | null)[] {
  const byDate = new Map(points.map((point) => [point.localDate, point.value]))
  return labels.map((label) => {
    const earlier = yearEarlier(label)
    return earlier === null ? null : byDate.get(earlier) ?? null
  })
}

export interface LastYear {
  /** Whether the reader has the comparison on. Everything below is empty while it is off. */
  on: boolean
  /** A metric's points from the year-earlier range, for a tile to summarise the way it summarises
   *  its own; empty while off or before the request answers. */
  pointsOf: (metric: string) => SeriesPoint[]
  /** Whether the year-earlier requests have all answered, so "nothing recorded" is a finding and
   *  not a page still loading. */
  settled: boolean
  /** A metric's year-earlier values dense over `labels`, for its sparkline. Stable per metric
   *  across renders, since a chart disposes itself when handed a new array (chart-lifecycle). */
  alignedOf: (metric: string) => (number | null)[] | undefined
  /**
   * A tile's "Last year" figure: the year-earlier points put through the tile's own `format`, so
   * a sum tile sums and a mean tile averages exactly as its headline does. Undefined while off or
   * loading (the tile draws nothing), null when a year earlier holds nothing for this metric.
   */
  summarise: (metric: string, format: (points: SeriesPoint[]) => string) => string | null | undefined
}

/**
 * The page's own metric groups, read again over the range a year earlier.
 *
 * The same `groups` constant the page already passes to useMetricGroups, so the hook order is the
 * same on every render and the comparison asks for exactly the metrics and aggs the tiles above it
 * draw. Disabled rather than unmounted while the comparison is off, which keeps the hooks in one
 * order and sends nothing.
 */
export function useLastYear(
  groups: readonly MetricGroup[], range: SeriesRange, labels: readonly string[], on: boolean,
): LastYear {
  const earlier = yearEarlierRange(range)
  const lastYear = useMetricGroups(groups, earlier, on)
  const data = lastYear.queries.map((query) => query.data)
  const settled = on && lastYear.queries.every((query) => !query.isPending)
  // A failed read is not an empty year. Saying "nothing recorded a year earlier" over a request
  // that errored would state something about the reader's history that nobody checked.
  const failed = lastYear.queries.some((query) => query.isError)

  const aligned = useMemo(() => {
    const out = new Map<string, (number | null)[]>()
    if (!on) return out
    for (const group of groups) {
      for (const metric of group.covers ?? group.metrics) {
        out.set(metric, alignYearEarlier(labels, lastYear.pointsOf(metric)))
      }
    }
    return out
    // `data` is spread so the memo follows each query's own answer; `groups` is a module constant
    // at every caller, so its length never changes and neither does this list's.
  }, [on, labels, ...data])

  return {
    on,
    settled,
    pointsOf: (metric) => (on ? lastYear.pointsOf(metric) : EMPTY),
    alignedOf: (metric) => aligned.get(metric),
    summarise: (metric, format) => {
      if (!settled || failed) return undefined
      const points = lastYear.pointsOf(metric)
      return points.length === 0 ? null : format(points)
    },
  }
}

const EMPTY = Object.freeze([]) as never[]
