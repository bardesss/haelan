import { cadenceOf } from '@haelan/core/source-cadence'
import type { UseQueryResult } from '@tanstack/react-query'
import type { MetricSeries } from './useSeries.js'
import { sourceParam } from '../controls/source.js'

/**
 * The cross-cutting pieces every page with a real range and a real control row needs, beyond its
 * own metric groups: which sources this person's queries have actually seen, and the one download
 * link the control row offers. Extracted out of Dashboard.tsx once Recovery.tsx needed a byte
 * identical copy of the first two functions and a copy of the third differing only in which
 * metrics and agg it names: MetricCard was extracted after eleven cards had already diverged
 * across one page, so two pages sharing this unextracted is the same shape one task earlier, and
 * cheaper to fix now than after Activity and Sleep copy it a third and fourth time.
 */

// sourceMix is nullable, and when present is JSON this app did not itself just produce
// (packages/core/src/derive/merge.ts's encodeMix writes it, but a row from an older mapping
// version or a hand edited value is just a string as far as this reads it): a malformed value
// must not take the page down over what is, at worst, a temporarily incomplete source list.
export function sourcesIn(raw: string | null): string[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((entry) => (entry !== null && typeof entry === 'object' ? (entry as { source?: unknown }).source : undefined))
    .filter((source): source is string => typeof source === 'string')
}

// The device names offered in the control row's source selector, pulled off whichever query
// results are passed in rather than a route of its own. Every caller must pass a query scoped to
// the all sources sentinel: a page whose range scoped queries fed this directly used to silently
// break the moment a device filter became active, since a per-source rollup carries no sourceMix
// (packages/core/src/derive/rollup.ts writes it null; only mergeDay's merged rows carry a real
// mix), so the enumeration went empty, the selector fell back to the sentinel, and the label
// silently relabelled itself "All sources" while the charts above it kept showing the device
// filtered numbers.
/**
 * The sources that fed this range and then went quiet before the end of it.
 *
 * The answer to the question a thinning chart actually raises - "did I get lazier, or did the
 * watch stop" - computed from the points the page has already loaded rather than from a request
 * of its own. `sourceMix` is on every merged row (13,408 of 14,074 in the archive this was
 * measured against), so no route, no read and nothing added to page load.
 *
 * Judged by `cadenceOf`, the same rule the settings card uses, with the end of the range standing
 * in for today. That keeps one threshold in one file: a second copy here would drift from the one
 * the server applies, and the two would disagree about the same source on the same day.
 *
 * Two things it cannot see, both stated rather than worked around. A source that stopped BEFORE
 * this range never appears in it, so only the settings card knows about long-dead sources - but
 * such a source is not what a thinning chart is about either. And `floors` and `total_calories`
 * are written under the `provider` tier, which has no merged row and therefore no mix at all, so
 * nothing here can speak for them.
 *
 * Takes the same all-sources-scoped queries `distinctSources` requires, for the same reason: a
 * per source rollup carries no mix, so a device-filtered query answers nothing.
 */
export function sourcesStoppedInRange(
  queries: readonly UseQueryResult<Record<string, MetricSeries>>[], rangeEnd: string,
): string[] {
  const datesBySource = new Map<string, string[]>()
  for (const query of queries) {
    for (const series of Object.values(query.data ?? {})) {
      for (const point of series.points) {
        for (const source of sourcesIn(point.sourceMix)) {
          // Duplicates are expected and harmless: one point per metric per day means the same
          // date arrives once per metric, and cadenceOf takes the distinct set.
          const dates = datesBySource.get(source)
          if (dates) dates.push(point.localDate)
          else datesBySource.set(source, [point.localDate])
        }
      }
    }
  }
  return [...datesBySource]
    .filter(([, dates]) => cadenceOf(dates, rangeEnd).status === 'stale')
    .map(([source]) => source)
    .sort()
}

export function distinctSources(queries: readonly UseQueryResult<Record<string, MetricSeries>>[]): string[] {
  const found = new Set<string>()
  for (const query of queries) {
    for (const series of Object.values(query.data ?? {})) {
      for (const point of series.points) {
        for (const source of sourcesIn(point.sourceMix)) found.add(source)
      }
    }
  }
  return [...found].sort()
}

/**
 * The one download link a page's control row offers. `metrics` and `agg` stay parameters rather
 * than a folded in default: /export takes exactly one `agg` per call, the same restriction /series
 * has (requireMetricAndAgg in packages/core/src/query/personQuery.ts), and Dashboard's primary
 * totals (sum) and Recovery's three once a day readings (last) are two different answers to "which
 * numbers is a reader downloading this page most likely to mean," not two configurations of one
 * answer.
 *
 * Routes `source` through sourceParam the same as baselinePath, seriesPath, nightsPath and
 * insightPath do, so the all sources sentinel is omitted rather than sent literally. This one used
 * to set it unconditionally: requireSource in packages/core/src/query/personQuery.ts knows no
 * source called 'all', so the default view's download link 400ed on every page while every chart
 * above it, built through one of those other four functions, rendered fine.
 */
export function exportPathFor(
  personId: string, metrics: readonly string[], agg: string, range: { from: string, to: string, source: string },
): string {
  const params = new URLSearchParams()
  for (const metric of metrics) params.append('metric', metric)
  params.set('format', 'csv')
  params.set('agg', agg)
  params.set('from', range.from)
  params.set('to', range.to)
  const source = sourceParam(range.source)
  if (source !== undefined) params.set('source', source)
  return `/api/v1/p/${personId}/export?${params.toString()}`
}
