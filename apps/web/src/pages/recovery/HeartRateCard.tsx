import { useMemo } from 'react'
import { Card } from '../../components/Card.js'
import { MetricCard } from '../../components/MetricCard.js'
import { EmptyState } from '../../components/EmptyState.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { HeartRateRange } from '../../charts/HeartRateRange.js'
import { IntradayHeartRate, intradayBasis } from '../../charts/IntradayHeartRate.js'
import type { RangeKey } from '../../controls/range.js'
import { useSeries } from '../../data/useSeries.js'
import { useBaseline } from '../../data/useBaseline.js'
import { useIntraday } from '../../data/useIntraday.js'
import { useDataTypes } from '../../data/useDataTypes.js'
import { dataTypeForMetric } from '@haelan/core/metric-data-type'
import { useTranslation } from '../../i18n/index.js'
import { wornOn } from '../../data/emptyState.js'

// One array for every prop and every fallback that is deliberately empty. A fresh [] on every
// render gives the chart's `build` callback a new identity, which useChart reads as "rebuild", so
// a literal handed straight to a chart prop was enough to dispose and re-initialise an echarts
// instance on every commit of this card. Its own copy rather than one imported from a page file,
// so the card carries nothing from the page it moved out of.
const EMPTY = Object.freeze([]) as never[]

/**
 * The heart rate range card, and the Day tab's whole-day heart rate trace that replaces it on that
 * one tab: the two views the old Dashboard drew at its own foot before M9b, moved verbatim into a
 * component of their own when the Dashboard became the glance, and mounted now only by Recovery.
 * The range chart draws three series (min, mean, max) rather than one because a day's heart rate
 * is a spread, not a single number, and the Day tab draws the day's own minute by minute trace
 * instead of a range chart that would otherwise hold at most one row.
 *
 * Owns its own queries rather than reading them off a page's shared groups: `from`/`to`/
 * `historicalTo`/`source`/`tab`/`rangeDates`/`period` are the page state this card needs, handed in
 * as props, and `annotations`/`excluded` are the heart_rate slice of a page's own overrides/day
 * annotations lookups (each page already builds those for its own cards) rather than a lookup this
 * card would otherwise have to duplicate against a page's own overridesByMetricMap.
 */
export function HeartRateCard({
  from, to, historicalTo, source, tab, rangeDates, period, annotations, excluded, onDayClick, onSampleClick, span,
}: {
  from: string
  to: string
  historicalTo: string
  source: string
  tab: RangeKey
  rangeDates: string[]
  period: string
  annotations: { date: string, text: string }[]
  excluded: string[]
  onDayClick: (localDate: string) => void
  onSampleClick: (point: { sourceId: string, utcMs: number, n: number }) => void
  span: number
}) {
  const { t } = useTranslation()
  const range = { from, to, source }
  const meanSeries = useSeries(['heart_rate'], range, 'mean')
  const minHrSeries = useSeries(['heart_rate'], range, 'min')
  const maxHrSeries = useSeries(['heart_rate'], range, 'max')
  // 'mean' explicitly: useBaseline defaults to 'sum', which heart_rate's catalogue entry does not
  // list, and the default would 400 the request (ConfigError, requireSource/requireMetricAndAgg)
  // the same way it would for /series.
  // Anchored on the range end, not on controls.anchor: baselineWindow reads the sixty days
  // before `on`, and the chart under this band draws from..to. Anchoring on controls.to rather
  // than controls.anchor is what lets the basis line state when the window actually ends: a Year
  // view's anchor can sit months away from the range the chart draws, and the basis line used to
  // report that anchor date instead of the one the drawn band was really computed against.
  // historicalTo, not to itself: on the default Month view `to` is the calendar month's last day,
  // which has not happened yet for all but that one day, and a sixty day window ending there asked
  // for history that does not exist rather than the sixty real days behind today.
  const hrBaseline = useBaseline('heart_rate', historicalTo, source, 'mean')

  // Every other card on this page reads its own exclusion through MetricCard, which calls this
  // same hook internally (data-types.ts's own dataTypesKey, so this costs no second request). The
  // Day tab's intraday heart rate card below is not a MetricCard -- see its own comment for why --
  // and used to have no exclusion check at all, claiming "no data" for a type nobody had asked
  // haelan to fetch in the first place.
  const { items: dataTypes, isPending: dataTypesPending } = useDataTypes()
  const excludedDataTypes = dataTypes.filter((d) => d.excluded).map((d) => d.id)

  // The Day tab's own query, unrelated to the three above: those read the daily aggregate series
  // (one row per calendar day), which on a one day range holds at most one row and cannot draw a
  // trend; this reads the day's own minute by minute samples instead. Called unconditionally
  // (React's own rule, not a choice) and gated by `enabled` rather than by an `if`, so it never
  // fires outside the Day tab it exists for. `source`, not a raw control: the page already
  // resolves a stale or foreign source name to the all sources sentinel for every other request,
  // and reading a raw control here would let this one card query a device the reader does not have
  // while every other card on the page fell back.
  const intraday = useIntraday({ metric: 'heart_rate', date: from, source }, { enabled: tab === 'day' })

  // Heart rate range: one day per date in range, min/mean/max looked up by localDate rather than
  // zipped by array position, because each of the three requests can be silent on a different day
  // (a source that only samples during waking hours never reports a night-time minimum) and the
  // three arrays are not guaranteed to line up index for index.
  const meanHrPoints = meanSeries.data?.heart_rate?.points ?? EMPTY
  const minHrPoints = minHrSeries.data?.heart_rate?.points ?? EMPTY
  const maxHrPoints = maxHrSeries.data?.heart_rate?.points ?? EMPTY
  const heartRateDays = useMemo(() => {
    const meanHrByDate = new Map(meanHrPoints.map((p) => [p.localDate, p]))
    const minHrByDate = new Map(minHrPoints.map((p) => [p.localDate, p]))
    const maxHrByDate = new Map(maxHrPoints.map((p) => [p.localDate, p]))
    return rangeDates.map((date) => {
      const meanPoint = meanHrByDate.get(date)
      return {
        date,
        steps: null, sleepMinutes: null,
        hrMin: minHrByDate.get(date)?.value ?? null,
        hrMean: meanPoint?.value ?? null,
        hrMax: maxHrByDate.get(date)?.value ?? null,
        // true (not worn) when there is no point at all: a missing point already reads as "no
        // reading" through the null cells above, and adding "not worn" on top of that would
        // assert a specific reason for the gap this data does not support. false only when a
        // point exists and its own coverage answers the question.
        worn: meanPoint === undefined || (wornOn('heart_rate', meanPoint) ?? true),
      }
    })
  }, [rangeDates, meanHrPoints, minHrPoints, maxHrPoints])
  const rawBaseline = hrBaseline.data?.baseline ?? null
  // Thin stays undefined, not a band drawn thin: a band computed from three days looks exactly as
  // authoritative as one computed from thirty, and thin is the reader's only signal that it is
  // not.
  const heartRateBand = useMemo(() => (rawBaseline !== null && !rawBaseline.thin
    ? { low: rawBaseline.center - rawBaseline.spread, high: rawBaseline.center + rawBaseline.spread }
    : undefined), [rawBaseline])
  // The basis line's band clause tracks whether heartRateBand is actually defined above, rather
  // than a single static string claiming a band that a thin or absent baseline never draws.
  const heartRateBasisKey = hrBaseline.isError
    // "No baseline yet" would be a claim about the person's history. A request that failed says
    // nothing about how much history there is.
    ? 'recovery.heartRateRange.basisBaselineUnknown'
    // Ahead of the null test for the same reason: /baselines settles independently of the three
    // heart rate series MetricCard gates on, so `data` is undefined for a while after this card
    // has drawn, and reading that as "no baseline yet" is the claim the comment above refuses.
    : hrBaseline.isPending
      ? 'recovery.heartRateRange.basisBaselinePending'
      : rawBaseline === null
        ? 'recovery.heartRateRange.basisNoBaseline'
        : rawBaseline.thin
          ? 'recovery.heartRateRange.basisThin'
          : 'recovery.heartRateRange.basis'
  // All three requests, not only the mean: a card drawing three series has not settled until
  // the last of them has, and has failed if any of them did. The empty check itself, and the
  // baseline omission it depends on, now live in MetricCard: this composite query is only built
  // here because MetricCard takes one query object, not three.
  const heartRateFailed = meanSeries.isError || minHrSeries.isError || maxHrSeries.isError
  // Whichever of the three actually failed - MetricCard's own not_found branch (ErrorState) needs
  // one concrete error to read a kind off, and a demo manifest miss on any of the three throws the
  // same ApiError('not_found') regardless of which query it lands on.
  const heartRateError = meanSeries.error ?? minHrSeries.error ?? maxHrSeries.error
  const retryHeartRate = () => {
    void meanSeries.refetch()
    void minHrSeries.refetch()
    void maxHrSeries.refetch()
  }
  const heartRatePending = meanSeries.isPending || minHrSeries.isPending || maxHrSeries.isPending

  // basisKey and basisWornKey are the same string here on purpose: this card's basis is a four
  // way choice driven by the baseline's own validity (unknown, absent, thin, real), not by
  // whether heart_rate carries a wear signal (it does, so MetricCard would otherwise always pick
  // basisWornKey), and MetricCard has no third slot for that choice. Collapsing both props to the
  // one key heartRateBasisKey already selected means MetricCard's own wear/plain switch has
  // nothing left to decide between; whichever branch it takes renders the same text. worn/count/
  // reported still land in the call MetricCard makes for the wear branch, but heartRateBasisKey's
  // four templates reference none of them, so they are unused interpolation values, not a second,
  // competing basis. heartRateBand goes to HeartRateRange below, never to MetricCard: a thin
  // baseline should blank only the band that chart draws around its lines, not the lines
  // themselves, and MetricCard's own `baseline` prop, which once fed emptyStateFor's `insufficient`
  // branch, went with that branch: M3e-2 marked both for removal, and this task removed them as
  // dead code no caller ever reached.
  return tab === 'day' ? (
    // With from === to the daily series this card used to read holds at most one row (see
    // emptyStateFor's own opening comment in emptyState.ts for why a one day range is
    // deliberately not one of its states), so what it drew was one dot standing in for
    // the "daily minimum, mean and maximum" its own label claimed. The Day tab draws the
    // day's own trace instead. Not a MetricCard: useIntraday answers a different question
    // than meanHrPoints (minute by minute samples through one day, not one row per day in a
    // range) and emptyStateFor's gate was built to read the latter, so this hand rolls the
    // same error/pending/empty order MetricCard enforces elsewhere, the same shape the sleep
    // stages and flagged days cards already use for a query MetricCard cannot gate on.
    // Nothing at all rather than an empty Card when the day truly has no samples, the same
    // rule the sleep stages card follows just below: the exclusion branch keeps its card,
    // since "not being synced" is still something to say about the day, and only the
    // genuinely empty points.length === 0 case disappears.
    // dataTypesPending joins the conditions that KEEP this card for the same reason
    // MetricCard's own gate reads it (see that file): excludedDataTypes is [] while the data
    // types request is in flight, which is indistinguishable from a loaded list excluding
    // nothing, so without it a reader who turned heart rate off watches this card vanish for
    // a moment instead of being told it is not being synced.
    intraday.isError || intraday.isPending || dataTypesPending
      || excludedDataTypes.includes(dataTypeForMetric('heart_rate') ?? '')
      || intraday.data.points.length > 0 ? (
      <Card span={span} label={t('recovery.heartRateRange.label')}
        basis={intraday.data ? intradayBasis(t, intraday.data.reduction, intraday.data.points.length) : undefined}>
        {intraday.isError ? <ErrorState onRetry={() => void intraday.refetch()} error={intraday.error} />
          : intraday.isPending ? <Loading />
          // Ahead of the exclusion check below, which cannot be trusted until the list it
          // reads has arrived: an unloaded list would answer "not excluded" and fall through
          // to a chart drawn over zero points.
          : dataTypesPending ? <Loading />
          // Checked ahead of the real no-data branch below, the same precedence emptyStateFor
          // gives excludedTypes over both of its own no_data and not_worn checks: an excluded
          // type has nothing this request could ever have answered, so the exclusion is the
          // more specific and more actionable truth. dataTypeForMetric('heart_rate') is
          // 'heart-rate', an ordinary excludable catalogue entry, so this is exactly the
          // dataTypes/excludedTypes pair MetricCard's own gate reads, not a second rule.
          : excludedDataTypes.includes(dataTypeForMetric('heart_rate') ?? '') ? (
            <EmptyState title={t('emptyState.not_synced.title')} detail={t('emptyState.not_synced.detail')} />
          ) : (
            <IntradayHeartRate points={intraday.data.points} reduction={intraday.data.reduction}
              label={t('recovery.heartRateRange.intradayChartLabel', { date: from })}
              onPointClick={onSampleClick} />
          )}
      </Card>
    ) : null
  ) : (
    <MetricCard metric="heart_rate" span={span} label={t('recovery.heartRateRange.label')} basisPlacement="header"
      query={{ isError: heartRateFailed, isPending: heartRatePending, refetch: retryHeartRate, error: heartRateError }}
      points={meanHrPoints}
      basisKey={heartRateBasisKey} basisWornKey={heartRateBasisKey} basisValues={{ on: historicalTo }}>
      {() => (
        // HeartRateRange has taken annotations/excluded since D1; annotations/excluded are the
        // same heart_rate lookup every other card on the page uses, resolved by the caller and
        // handed in rather than looked up a second time here.
        <HeartRateRange days={heartRateDays} baseline={heartRateBand}
          annotations={annotations}
          excluded={excluded}
          label={t('recovery.heartRateRange.chartLabel', { period })}
          onPointClick={onDayClick} />
      )}
    </MetricCard>
  )
}
