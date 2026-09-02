import { coverageIsMeaningful } from '@haelan/core/coverage-signal'
import type { SeriesPoint } from './useSeries.js'
import type { Baseline } from './useBaseline.js'

export type EmptyStateKind = 'no_data' | 'not_worn' | 'insufficient'

/**
 * Whether a metric's coverage is a statement about whether a device was worn.
 *
 * Imported rather than copied, unlike Dashboard.tsx's own metric-to-agg map: this question is
 * answered by packages/core/src/query/coverageSignal.ts, which packages/core publishes through
 * the browser safe @haelan/core/coverage-signal subpath (catalogue.ts imports only a type from
 * the schema, erased by verbatimModuleSyntax, so nothing native rides along). A copy here used to
 * mean a ninth intraday metric added to core would silently make wornOn return null for it, so
 * not_worn could never fire and the basis line would quietly drop its wear clause, with nothing
 * in apps/web able to detect either.
 *
 * The distinction matters more here than the list does. Coverage is the fraction of the day's
 * hours carrying a sample, which is comparable within a metric and meaningless across metrics: a
 * resting heart rate arrives once a day, so a perfect one reads 1/24, and a heart rate at 1/24 is
 * a watch worn for an hour. Judging both against one number reads the second's failure into the
 * first's normal.
 */
export function coverageIsWearSignal(metric: string): boolean {
  return coverageIsMeaningful(metric)
}

/**
 * The highest coverage that still means nobody was wearing anything.
 *
 * packages/core/src/derive/coverage.ts computes coverage as `hours.size / 24`, and a row is only
 * emitted where at least one sample fed it, so the smallest coverage a real row can carry is
 * 1/24: zero is not a value the derivation can write. "Rows exist and coverage is zero" therefore
 * describes a row nothing can produce, which left the not_worn branch unreachable for the thing
 * it means and reachable only where it was false. One hour is what the threshold has to be
 * instead: a continuously sampled metric that touched a single hour of the day is a device that
 * was picked up, not one that was worn.
 */
export const NOT_WORN_MAX_COVERAGE = 1 / 24

/**
 * Whether a point's own coverage says the device was worn that day: null when the point cannot
 * answer, which is a third case and never a false.
 *
 * A sleep row carries `coverage: null` on purpose (packages/core/src/derive/sleep.ts: "a night
 * has no samples underneath it, so the fraction of the day's hours carrying one is not a question
 * this row can answer"), and a metric outside the wear signal list carries a coverage that means
 * something other than wear. Reading either as a zero states a cause the data refuses to.
 */
export function wornOn(metric: string, point: SeriesPoint): boolean | null {
  if (!coverageIsWearSignal(metric) || point.coverage === null) return null
  return point.coverage > NOT_WORN_MAX_COVERAGE
}

/**
 * Which of the three empty states a card should render, or null to render the data.
 *
 * The parent spec requires these read differently and that none renders as zero or as a blank
 * chart, because "no naps detected", "device not worn" and "not enough data to summarise" are
 * three different statements and only one of them is a number.
 */
export function emptyStateFor(
  metric: string, points: SeriesPoint[] | undefined, baseline?: Baseline | null,
): EmptyStateKind | null {
  // Ordered strongest first. Nothing at all outranks a thin baseline: telling a reader their
  // baseline is thin implies there is a series it was thin against.
  if (points === undefined || points.length === 0) return 'no_data'

  // Only the rows that can answer the coverage question get a vote, and a metric with no such
  // row never reaches this state at all. Zero is an answer and null is the absence of one, which
  // is the rule this function is named for and used to break one field over.
  const answers = points.map((point) => wornOn(metric, point)).filter((w): w is boolean => w !== null)
  if (answers.length > 0 && !answers.includes(true)) return 'not_worn'

  // Dead code: no caller in apps/web ever passes a baseline here. Dashboard.tsx withholds one on
  // purpose, because a thin baseline should blank the band a chart draws rather than the lines
  // themselves, so a chart card should never reach `insufficient` through this function at all.
  // The copy this branch would have shown now lives on a suppressed insight card's own
  // `thin-days` reason (InsightCard.tsx), which reuses `emptyState.insufficient` verbatim without
  // ever calling this function or consulting a baseline. Recorded here rather than deleted yet:
  // M3e-2's own spec (section 2) calls this the branch's real home and marks it for removal.
  if (baseline != null && baseline.thin) return 'insufficient'

  return null
}
