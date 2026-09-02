import type { ReactNode } from 'react'
import { useTranslation } from '../i18n/index.js'
import { Card } from './Card.js'
import { ErrorState } from './ErrorState.js'
import { Loading } from './Loading.js'
import { EmptyState } from './EmptyState.js'
import { formatMetricValue } from '../format.js'
import type { Insight } from '../data/useInsight.js'

/**
 * A period against the one before it, read as a sentence rather than as the `.delta` chip a
 * metric card already carries beside it. The chip states the size of a change; this states what
 * the two numbers behind it actually were, "455 ... against 473 ...", which a chip's "down 4%"
 * cannot. Dropping the previous value here would leave nothing this card says that the chip does
 * not already say, so `previous` and both windows are never optional in the rendered sentence.
 *
 * Presentational, on purpose: the page that mounts this owns the `useInsight` call and hands the
 * result down, the way `MetricCard` takes a query and points rather than fetching for itself. A
 * component that fetches internally cannot be handed a fixture, which is what makes both
 * suppressed branches below testable without stubbing a network call.
 *
 * `insight` is `undefined` until the query resolves, mirroring `MetricCard`'s `points` gate; a
 * defined `insight` with `query.isPending` still true or `query.isError` still true does not
 * happen in practice (a resolved query is exactly what makes `insight` defined), but the error
 * check runs first regardless, for the same reason `MetricCard`'s own comment gives: a composite
 * query built by ORing several together can carry both flags at once, and a failed request is
 * never the same statement as an empty or thin period.
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
  if (insight.suppressed) {
    const thinCoverage = insight.reason === 'thin-coverage'
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
        currentFrom: insight.currentRange?.from ?? '',
        currentTo: insight.currentRange?.to ?? '',
        previousFrom: insight.previousRange?.from ?? '',
        previousTo: insight.previousRange?.to ?? '',
      })}</p>
    </Card>
  )
}
