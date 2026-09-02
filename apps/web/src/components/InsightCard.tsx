import type { ReactNode } from 'react'
import { useTranslation } from '../i18n/index.js'
import { Card } from './Card.js'
import { ErrorState } from './ErrorState.js'
import { Loading } from './Loading.js'
import { EmptyState } from './EmptyState.js'
import { formatMetricValue, formatLocalDate } from '../format.js'
import type { Insight } from '../data/useInsight.js'

/**
 * A period against the one before it, read as a sentence rather than as the `.delta` chip a
 * metric card already carries beside it. The chip states the size of a change; this states what
 * the two numbers behind it actually were, "455 on average ... against 473 on average ...",
 * which a chip's "down 4%" cannot. Dropping the previous value here would leave nothing this card
 * says that the chip does not already say, so `previous` and both windows are never optional in
 * the rendered sentence.
 *
 * `current`/`previous` are each a mean over the days in their window, never a period total, and
 * that is true regardless of which `agg` the caller passed to `useInsight`: `comparePeriods`
 * (`packages/core/src/query/insights.ts`, `meanOf`) always averages the daily points it was
 * handed, so a caller asking for `sum` gets the mean of each day's own sum, not the sum of the
 * whole period. `insightCard.summary` says "on average" for exactly this reason, and a caller
 * whose tile above prints a period total (a `sum` agg tile summed client side, the way `steps`'s
 * tile does) is describing a different quantity from this card even when both read the same
 * `metric`; that is expected, not a bug in either.
 *
 * `formatValue`, where the metric's own tile carries a unit or a non-default format the plain
 * `formatMetricValue` call below does not (a "bpm" suffix, a duration string), is not optional
 * for that metric: without it, this card's number reads unitless beside a tile that carries one.
 *
 * Presentational, on purpose: the page that mounts this owns the `useInsight` call and hands the
 * result down, the way `MetricCard` takes a query and points rather than fetching for itself. A
 * component that fetches internally cannot be handed a fixture, which is what makes both
 * suppressed branches below testable without stubbing a network call.
 *
 * `insight` stays `undefined` until the query resolves, and the pending check below reads that
 * directly rather than assuming a defined `insight` implies a settled query. The error check still
 * runs first regardless, for the same reason `MetricCard`'s own comment gives: a composite query
 * built by ORing several together can carry both `isError` and `isPending` at once, and a failed
 * request is never the same statement as an empty or thin period.
 */
export function InsightCard({ insight, query, metric, span, label, formatValue }: {
  insight: Insight | undefined
  query: { isError: boolean, isPending: boolean, refetch: () => unknown }
  metric: string
  span: number
  label?: string
  // The optional override for a metric whose displayed unit differs from its stored one, the same
  // shape and the same reason as `Sparkline`'s prop of this name: `formatMetricValue` reads
  // precision off METRICS[metric], which is declared in the STORED unit, so a value already
  // converted to a different display unit (weight's grams shown as kilograms) has to carry its own
  // formatter rather than pass through the catalogue lookup and pick up the wrong precision.
  formatValue?: (value: number | null, absent: string) => string
}): ReactNode {
  const { t, i18n } = useTranslation()

  if (query.isError) {
    return <Card span={span} label={label}><ErrorState onRetry={() => void query.refetch()} /></Card>
  }
  if (query.isPending || insight === undefined) {
    return <Card span={span} label={label}><Loading /></Card>
  }

  // Suppression is the server's decision, not a local recomputation: `personQuery.comparePeriods`
  // (packages/core/src/query/insights.ts) already ran the day count and coverage gates against
  // the real thresholds, and `reason` says which one failed. Reading it here rather than deriving
  // a verdict from `currentDays`/`currentCoverage` a second time is what keeps this card's answer
  // from ever disagreeing with the one the server already computed.
  //
  // `thin-coverage` gets its own copy rather than sharing `thin-days`'s, because the two name
  // different remedies: a thin `reason` about days means wait longer, a thin `reason` about
  // coverage means wear the device more consistently. A reader told "not enough data" for both
  // would have no way to tell which fix applies to them. `emptyState.insufficient` is reused
  // verbatim for `thin-days`, not reimplemented, because that string already says exactly this
  // ("There are too few days here to say anything useful yet"); reusing it does not make
  // `emptyStateFor`'s own `insufficient` branch (gated on a thin baseline) reachable, since this
  // card never calls `emptyStateFor` and never consults a baseline at all.
  //
  // The second half of this condition guards two different gaps, not one. `current`/`previous`/
  // `delta` do go null together with `suppressed`/`reason` (`insights.ts`'s own `refuse`), so a
  // live suppressed insight is already caught by the check before this one. The ranges are
  // different: `personQuery.comparePeriods` (`packages/core/src/query/personQuery.ts:220-224`)
  // fills `currentRange`/`previousRange` unconditionally, suppressed or not, so a live,
  // well-formed response never actually carries a null range. Both of those describe what a
  // correctly shaped `Insight` can hand this component, which `== null` alone would already cover.
  //
  // `== null`, not `=== null`, because a real, reachable response is not always correctly shaped:
  // `apiSend` turns an empty body into `{}` for a 204 or a body-less error alike
  // (`apps/web/src/api/client.ts`, the `text === '' ? {} : JSON.parse(text)` line), and `apiGet`
  // casts that (or any other JSON) straight to `Insight` with no runtime check that the fields
  // named here are actually present. `{}` cast to `Insight` reads `current`/`previous`/`delta`/
  // both ranges as `undefined`, not `null`, and `undefined === null` is `false`, which is exactly
  // the gap that used to let `formatMetricValue` reach `undefined.toLocaleString()` below and take
  // the whole page down with it, not only this card: nothing in apps/web catches a render error.
  // `== null` treats `undefined` the same as the typed `null` case already handled above, so an
  // incomplete or version-skewed response falls back to the same "not enough data" empty state a
  // deliberately null field already does, rather than reaching the format calls at all.
  if (insight.suppressed || insight.current == null || insight.previous == null || insight.delta == null
    || insight.currentRange == null || insight.previousRange == null) {
    const thinCoverage = insight.suppressed && insight.reason === 'thin-coverage'
    return (
      <Card span={span} label={label}>
        <EmptyState
          title={t(thinCoverage ? 'insightCard.thinCoverage.title' : 'emptyState.insufficient.title')}
          detail={t(thinCoverage ? 'insightCard.thinCoverage.detail' : 'emptyState.insufficient.detail')}
        />
      </Card>
    )
  }

  // `delta` is taken straight off `insight`, never recomputed from `current` and `previous` here:
  // the route (apps/server/src/routes/v1/series.ts) already derives it from the two rounded ends
  // rather than from the comparison's raw arithmetic, specifically so a reader's own subtraction of
  // the two values this sentence prints agrees with the delta printed alongside them. Formatting it
  // through the same `format` as `current` and `previous` below reapplies that same, already
  // settled precision rather than a second, independent one.
  const format = (value: number | null): string =>
    formatValue ? formatValue(value, '') : formatMetricValue(value, metric, i18n.language, '')

  return (
    <Card span={span} label={label}>
      <p className="insight-summary">{t('insightCard.summary', {
        current: format(insight.current),
        previous: format(insight.previous),
        delta: format(insight.delta),
        currentFrom: formatLocalDate(insight.currentRange.from, i18n.language),
        currentTo: formatLocalDate(insight.currentRange.to, i18n.language),
        previousFrom: formatLocalDate(insight.previousRange.from, i18n.language),
        previousTo: formatLocalDate(insight.previousRange.to, i18n.language),
      })}</p>
    </Card>
  )
}
