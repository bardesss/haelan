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
//
// This file used to hold `sourcesStoppedInRange` beside it too: the sources that fed a range and
// went quiet inside it, judged in the browser off the same points, for a line in the control row.
// That warning moved to the status panel (StatusPanel.tsx), which reads the server's verdict over
// the person's whole history instead of one range's, so the page no longer judges anything itself.
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
