import { coverageIsMeaningful } from '@haelan/core/coverage-signal'
import { dataTypeForMetric } from '@haelan/core/metric-data-type'
import type { SeriesPoint } from './useSeries.js'

export type EmptyStateKind = 'no_data' | 'not_worn' | 'not_synced'

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
 * The parent spec requires these read differently and that neither renders as zero or as a blank
 * chart, because "no naps detected", "device not worn" and "you turned this off" are three
 * different statements and none of them is a number.
 *
 * `excludedTypes` is checked first, ahead of both `no_data` and `not_worn`, because it is the more
 * specific truth and the one reason here the reader can act on: the other two describe the data
 * that came back, and a type nobody fetches has no data to describe at all. It outranks
 * `not_worn` for a reason `not_worn` cannot get around on its own terms: "not worn" is a claim
 * about coverage this household's own rows recorded, and there is nothing to have recorded when
 * the type was never synced. Answering `not_worn` for an excluded type would state a fact about
 * evidence that does not exist.
 *
 * A third state, `insufficient`, lived here until M3e-2 marked it for removal: no caller in
 * apps/web ever passed a baseline, since Dashboard.tsx withholds one on purpose (a thin baseline
 * should blank the band a chart draws rather than the lines themselves), so the branch could
 * never fire through this function. Its copy lives on as a suppressed insight card's own
 * `thin-days` reason (InsightCard.tsx), which reuses the `emptyState.insufficient` translation
 * key verbatim without ever calling this function.
 */
export function emptyStateFor(
  metric: string, points: SeriesPoint[] | undefined, excludedTypes: readonly string[] = [],
): EmptyStateKind | null {
  // dataTypeForMetric answers null only for a metric no catalogue entry produces and no hand
  // written association names either (metricDataType.ts's own comment explains why sleep and
  // exercise need one: both are session-derived families with no data type of their own on the
  // catalogue, but they are excludable through 'sleep'/'exercise' all the same). Null can never be
  // a member of excludedTypes, so a metric that is genuinely nobody's falls through to the checks
  // below rather than needing a guard of its own here.
  const dataType = dataTypeForMetric(metric)
  if (dataType !== null && excludedTypes.includes(dataType)) return 'not_synced'

  // A one day range with a value is deliberately not read here at all, even though MetricCard
  // knows it (its own `oneDayRange` prop): this function answers "is there nothing to show", and
  // a one day range with a value has something to show, a number with no chart worth drawing
  // beside it. That is not the same question, and folding it in here once meant the early return
  // below MetricCard takes for every kind in this union discarded the StatTile, its delta and the
  // basis line along with the chart, on a range where none of the three had anything wrong with
  // them. MetricCard reads `oneDayRange` itself and hands it to `children`, which is the one place
  // that can swap out the chart alone and leave the rest of the card standing.
  if (points === undefined || points.length === 0) return 'no_data'

  // Only the rows that can answer the coverage question get a vote, and a metric with no such
  // row never reaches this state at all. Zero is an answer and null is the absence of one, which
  // is the rule this function is named for and used to break one field over.
  const answers = points.map((point) => wornOn(metric, point)).filter((w): w is boolean => w !== null)
  if (answers.length > 0 && !answers.includes(true)) return 'not_worn'

  return null
}

/**
 * Whether a card in this state should render nothing at all rather than an empty shell.
 *
 * The rule, which is what a later reader should apply to a fourth kind: an absence the reader can
 * act on stays on screen; an absence they can only wait out disappears. `not_synced` names a
 * switch in Settings and is the last trace that the data type exists at all. `not_worn` names a
 * remedy too — wear the device — and without it the reader blames the app for a gap their own
 * week caused. `no_data` names neither: a card whose only job was to show this period, saying it
 * has nothing to show for this period, tells the reader something they already know.
 *
 * A function over the kind rather than a set literal or a field on each kind, so a fourth kind is
 * a type error here until someone classifies it, rather than defaulting silently into either
 * behaviour.
 */
export function hidesWhenEmpty(kind: EmptyStateKind): boolean {
  switch (kind) {
    case 'no_data': return true
    case 'not_worn': return false
    case 'not_synced': return false
  }
}
