import { useId, useMemo } from 'react'
import { MetricCard } from '../../components/MetricCard.js'
import { BasisContext } from '../../components/basis.js'
import { HeartRateRange } from '../../charts/HeartRateRange.js'
import { periodAxisLabels } from '../../charts/barAxis.js'
import { heartRateWeeks } from '../../charts/heartRateWeeks.js'
import type { PeriodRange } from '../../data/periodTypes.js'
import { useSeries } from '../../data/useSeries.js'
import { useBaseline } from '../../data/useBaseline.js'
import { useTranslation } from '../../i18n/index.js'
import { wornOn } from '../../data/emptyState.js'

// One array for every prop and every fallback that is deliberately empty. A fresh [] on every
// render gives the chart's `build` callback a new identity, which useChart reads as "rebuild", so
// a literal handed straight to a chart prop was enough to dispose and re-initialise an echarts
// instance on every commit of this card. Its own copy rather than one imported from a page file,
// so the card carries nothing from the page it moved out of.
const EMPTY = Object.freeze([]) as never[]

/**
 * The heart rate range card: a day's minimum, mean and maximum through the period, against the
 * band of the sixty days before its last day. Drawn by the old Dashboard at its own foot before
 * M9b, and mounted now only by Recovery, at span 12 under the overview's figures. Three series
 * (min, mean, max) rather than one because a day's heart rate is a spread, not a single number.
 *
 * Periods only: the Day tab's minute-by-minute trace went with Recovery's Day tab, which opens the
 * dashboard on that day, and the dashboard's day carries the trace.
 *
 * Owns its own queries rather than reading them off a page's shared groups: `from`/`to`/
 * `historicalTo`/`source`/`rangeDates`/`period` are the page state this card needs, handed in as
 * props, and `annotations`/`excluded` are the heart_rate slice of a page's own overrides lookup
 * rather than a lookup this card would otherwise have to duplicate. Recovery hands it the
 * overrides' reasons alone, no day notes or events: the overview pages draw none on their charts
 * (on a year they piled into one unreadable block), and the hero's day panel reaches them.
 *
 * On 3 months and Year a point is a Monday-to-Sunday week, clipped to the period (heartRateWeeks):
 * its lowest daily minimum, the mean of its daily means and its highest daily maximum, bucketed here
 * from the days already fetched. A year of single days was a crammed row of day numbers with no
 * month in it. A week is no one day to exclude or annotate, so its points open nothing and carry no
 * day's marks, as Sleep's weekly balance bars do. The x axis speaks the range on every tab
 * (periodAxisLabels), as the overview's bar charts do.
 *
 * Its basis is a `.dash-caption` under the chart, as the page's other captions are: what the lines
 * are, by the range in words, and what the band is ("band = your usual range"), or why none is
 * drawn. No date in it; the band's anchor is historicalTo, which the request carries.
 */
export function HeartRateCard({
  from, to, historicalTo, source, rangeDates, range: tab, period, periodWords, annotations, excluded, onDayClick, span,
}: {
  from: string
  to: string
  historicalTo: string
  source: string
  rangeDates: string[]
  /** The tab: Week and Month draw days, 3 months and Year weeks. */
  range: PeriodRange
  /** The range in dates, for the chart's accessible name. */
  period: string
  /** The range in words ("this month", thisPeriod), for the caption under the chart. */
  periodWords: string
  annotations: { date: string, text: string }[]
  excluded: string[]
  onDayClick: (localDate: string) => void
  span: number
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const weekly = tab === '3months' || tab === 'year'
  // The caption's id, which the chart is described by (BasisContext), as the header basis it was.
  const captionId = useId()
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
  const points = useMemo(() => (weekly ? heartRateWeeks(heartRateDays) : heartRateDays), [weekly, heartRateDays])
  const axis = useMemo(() => periodAxisLabels(points.map((point) => point.date), tab, language), [points, tab, language])
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
  return (
    <MetricCard metric="heart_rate" span={span} label={t('recovery.heartRateRange.label')} basisPlacement="body"
      query={{ isError: heartRateFailed, isPending: heartRatePending, refetch: retryHeartRate, error: heartRateError }}
      points={meanHrPoints}
      basisKey={heartRateBasisKey} basisWornKey={heartRateBasisKey}
      basisValues={{ lines: t(weekly ? 'recovery.heartRateRange.lines.weekly' : 'recovery.heartRateRange.lines.daily', { period: periodWords }) }}>
      {(basis) => (
        <>
          {/* HeartRateRange has taken annotations/excluded since D1, resolved by the caller and
              handed in rather than looked up a second time here. */}
          <BasisContext.Provider value={captionId}>
            <HeartRateRange days={points} baseline={heartRateBand} axis={axis}
              annotations={weekly ? EMPTY : annotations}
              excluded={weekly ? EMPTY : excluded}
              label={t(weekly ? 'recovery.heartRateRange.chartLabelWeekly' : 'recovery.heartRateRange.chartLabel', { period })}
              onPointClick={weekly ? undefined : onDayClick} />
          </BasisContext.Provider>
          <p id={captionId} className="dash-caption">{basis}</p>
        </>
      )}
    </MetricCard>
  )
}
