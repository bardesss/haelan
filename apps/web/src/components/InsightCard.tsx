import type { ReactNode } from 'react'
import { useTranslation } from '../i18n/index.js'
import { Card } from './Card.js'
import { ErrorState } from './ErrorState.js'
import { Loading } from './Loading.js'
import { EmptyState } from './EmptyState.js'
import { formatMetricValue, formatLocalDate, formatLocalDateRange, toneFor } from '../format.js'
import type { Delta, Polarity } from '../format.js'
import type { Insight } from '../data/useInsight.js'

/**
 * A period against the one before it: both figures, both windows, and the difference, where a
 * metric card's own `.delta` chip states only the size of a change. The chip says "down 4%"; this
 * says what the two numbers behind it actually were. Dropping the previous value would leave
 * nothing this card says that the chip does not, so `previous` and both windows are never
 * optional, either in the figures drawn or in the sentence a screen reader is given instead.
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
export function InsightCard({ insight, query, metric, span, label, formatValue, formatDelta, polarity = 'neutral' }: {
  insight: Insight | undefined
  // Optional, same reason MetricCard's own query prop carries it: only ErrorState's not_found
  // branch reads it.
  query: { isError: boolean, isPending: boolean, refetch: () => unknown, error?: unknown }
  metric: string
  span: number
  label?: string
  // The optional override for a metric whose displayed unit differs from its stored one, the same
  // shape and the same reason as `Sparkline`'s prop of this name: `formatMetricValue` reads
  // precision off METRICS[metric], which is declared in the STORED unit, so a value already
  // converted to a different display unit (weight's grams shown as kilograms) has to carry its own
  // formatter rather than pass through the catalogue lookup and pick up the wrong precision.
  formatValue?: (value: number | null, absent: string) => string
  // The override for the one card whose `formatValue` above converts to a different display
  // unit: without this, `delta` below falls back to `insight.delta`, which the route derives from
  // the two rounded ends at the metric's STORED precision (series.ts's own comment on why), not
  // the displayed one. Dividing that stored-precision delta into the display unit afterwards
  // crosses a rounding boundary the two already-converted, already-rounded ends do not, the exact
  // shape the route's own comment exists to rule out one level up. `formatDelta`, when given,
  // receives the same raw `current`/`previous` this component already reads off `insight` and
  // returns the finished, unit-suffixed string, so the caller can run the route's own technique
  // again at the display precision rather than trust a delta computed at a different one.
  formatDelta?: (current: number, previous: number) => string
  // Whether a rise is good news, for the badge's colour: the same polarity the metric's own tile
  // passes to deltaFor. Neutral by default, so a caller that says nothing gets no colour rather
  // than a guessed one.
  polarity?: Polarity
}): ReactNode {
  const { t, i18n } = useTranslation()

  if (query.isError) {
    return <Card span={span} label={label}><ErrorState onRetry={() => void query.refetch()} error={query.error} /></Card>
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
  // would have no way to tell which fix applies to them. `thin-days` renders nothing at all now
  // (the branch below this one): "wait longer" is not news, and it is not a remedy the reader
  // wanted to hear repeated on every one of these cards that lands on it at once on a Day tab.
  //
  // thin-coverage keeps its card for the reason not_worn keeps its own (emptyState.ts's
  // hidesWhenEmpty): it names a remedy the reader can act on, and without it they blame the app
  // for a gap their own week caused. It is checked first because the condition below subsumes it.
  if (insight.suppressed && insight.reason === 'thin-coverage') {
    return (
      <Card span={span} label={label}>
        <EmptyState title={t('insightCard.thinCoverage.title')} detail={t('insightCard.thinCoverage.detail')} />
      </Card>
    )
  }
  // Nothing at all, not an empty Card: the shell reports a card's presence to the enclosing
  // CardGrid, so an empty one would keep the page claiming it has something to show.
  //
  // Two different absences share this line. thin-days says to wait, which the reader already
  // knows and which every one of these cards says at once on a Day tab. The `== null` half is the
  // defensive guard for a malformed or version-skewed payload — apiGet casts any JSON straight to
  // Insight with no runtime check, and `{}` reads every field as undefined rather than null,
  // which is why this is `==` and not `===`. It exists to stop that reaching the format calls
  // below and taking the whole page down, not only this card; a card that does not appear serves
  // that as well as a fallback message did, and claims nothing about the person's record.
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
  // incomplete or version-skewed response now renders nothing at all, rather than reaching the
  // format calls below.
  if (insight.suppressed || insight.current == null || insight.previous == null || insight.delta == null
    || insight.currentRange == null || insight.previousRange == null) {
    return null
  }

  // `delta` is taken straight off `insight` by default, never recomputed from `current` and
  // `previous` here: the route (apps/server/src/routes/v1/series.ts) already derives it from the
  // two rounded ends rather than from the comparison's raw arithmetic, specifically so a reader's
  // own subtraction of the two values this sentence prints agrees with the delta printed alongside
  // them. Formatting it through the same `format` as `current` and `previous` below reapplies that
  // same, already settled precision rather than a second, independent one. That default is correct
  // only when `current` and `previous` are shown in the metric's own stored unit, which is why the
  // one card that is not (`formatValue` given, a converted display unit) passes `formatDelta`
  // instead of relying on it; see that prop's own comment for the failure it would otherwise
  // reintroduce.
  const format = (value: number | null): string =>
    formatValue ? formatValue(value, '') : formatMetricValue(value, metric, i18n.language, '')

  const current = format(insight.current)
  const previous = format(insight.previous)
  const delta = formatDelta ? formatDelta(insight.current, insight.previous) : format(insight.delta)
  const currentFrom = formatLocalDate(insight.currentRange.from, i18n.language)
  const currentTo = formatLocalDate(insight.currentRange.to, i18n.language)
  const previousFrom = formatLocalDate(insight.previousRange.from, i18n.language)
  const previousTo = formatLocalDate(insight.previousRange.to, i18n.language)

  // Direction from the delta the card prints, so the badge's colour and its sign cannot disagree.
  const dir: Delta['dir'] = insight.delta === 0 ? 'flat' : insight.delta > 0 ? 'up' : 'down'
  // A plus on a rise, and a real minus sign on a fall. Formatters answer a hyphen-minus, which sits
  // too low and too short beside digits to read as a sign at a glance.
  const signed = dir === 'up' && !delta.startsWith('+') ? `+${delta}` : delta.replace(/^-/, '−')
  // Two bars on one scale, the larger filling the track. Means of these metrics are never
  // negative; a non-positive pair draws two empty tracks rather than a bar pointing the wrong way.
  const top = Math.max(insight.current, insight.previous)
  const share = (value: number): string => `${top > 0 ? Math.max(0, (value / top) * 100) : 0}%`

  return (
    <Card span={span} label={label}>
      {/* Two figures and their difference, where this card used to print one long sentence that
          left the comparison to the reader. The sentence is kept, word for word, as what a screen
          reader hears: it says the same thing in the order a listener needs, and the figures
          above it are marked hidden so nothing is read twice. */}
      <div className="insight-compare" aria-hidden="true">
        <div className="insight-period">
          <span className="insight-period-label">{t('insightCard.current')}</span>
          <span className="insight-value">{current}</span>
          <span className="insight-range">{formatLocalDateRange(insight.currentRange.from, insight.currentRange.to, i18n.language)}</span>
        </div>
        <div className="insight-period insight-period-previous">
          <span className="insight-period-label">{t('insightCard.previous')}</span>
          <span className="insight-value">{previous}</span>
          <span className="insight-range">{formatLocalDateRange(insight.previousRange.from, insight.previousRange.to, i18n.language)}</span>
        </div>
        <span className="delta insight-delta" data-dir={dir} data-tone={toneFor(dir, polarity)}>{signed}</span>
      </div>
      <div className="insight-bars" aria-hidden="true">
        <span className="insight-bar"><span style={{ width: share(insight.current) }} /></span>
        <span className="insight-bar insight-bar-previous"><span style={{ width: share(insight.previous) }} /></span>
      </div>
      <p className="insight-summary sr-only">{t('insightCard.summary', {
        current, previous, delta, currentFrom, currentTo, previousFrom, previousTo,
      })}</p>
    </Card>
  )
}
