import { useMemo, useState } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { DEFAULT_SLEEP_TARGET_MINUTES, METRICS } from '@haelan/core/metrics'
import type { DailyAgg } from '@haelan/core/metrics'
import { useTranslation } from '../i18n/index.js'
import { StatTile } from '../components/StatTile.js'
import { MetricCard } from '../components/MetricCard.js'
import { ChartNote } from '../components/ChartNote.js'
import { InsightCard } from '../components/InsightCard.js'
import { Card } from '../components/Card.js'
import { CardGrid } from '../components/CardGrid.js'
import { Loading } from '../components/Loading.js'
import { ErrorState } from '../components/ErrorState.js'
import { ControlRow } from '../components/ControlRow.js'
import { NightExcludedSessions } from '../components/NightExcludedSessions.js'
import { AnnotatePanel } from '../components/AnnotatePanel.js'
import type { AnnotateTarget } from '../components/AnnotatePanel.js'
import { Sparkline } from '../charts/Sparkline.js'
import { BalanceBars } from '../charts/BalanceBars.js'
import { Hypnogram } from '../charts/Hypnogram.js'
import { SleepSchedule } from '../charts/SleepSchedule.js'
import { localMinutesOf, inWindow, napInWindow, withinSchedule, WIDE_WINDOW } from '../charts/schedule.js'
import { usePageControls } from '../controls/usePageControls.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { useSession } from '../auth/session.js'
import { denseSeries, useSeries } from '../data/useSeries.js'
import type { SeriesPoint } from '../data/useSeries.js'
import { useBaseline } from '../data/useBaseline.js'
import type { Baseline } from '../data/useBaseline.js'
import { useInsight } from '../data/useInsight.js'
import { useNights } from '../data/useNights.js'
import type { Night } from '../data/useNights.js'
import { oneNightPerDate, stageOf } from '../data/nights.js'
import { NightList } from './sleep/NightList.js'
import { useAnnotations } from '../data/useAnnotations.js'
import { overridesByMetric, annotationsFor } from '../data/chartAnnotations.js'
import { useDayAnnotations, annotationsWithDay } from '../data/dayAnnotations.js'
import { useMetricGroups } from '../data/useMetricGroups.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { distinctSources, sourcesStoppedInRange, exportPathFor } from '../data/pageShell.js'
import { formatDuration, formatSignedDuration, formatClock, deltaFor, formatMetricValue } from '../format.js'
import type { Translate, Polarity } from '../format.js'

// Every metric this page draws, checked against packages/core/src/derive/metrics.ts rather than
// taken on faith from the brief that named them: sleep_asleep_minutes, sleep_deep_minutes,
// sleep_light_minutes, sleep_rem_minutes, sleep_awake_minutes, sleep_in_bed_minutes and
// sleep_nap_minutes are all `sum` (a night's pieces summed into one figure), sleep_efficiency,
// sleep_bedtime_minutes and sleep_waketime_minutes are `last` (a night has exactly one of each),
// and sleep_nap_count is the one metric on this page whose only aggregate is `count`. Three
// requests, the same REQUESTS/under('agg') shape Dashboard.tsx, Recovery.tsx and Activity.tsx
// already use, so a pairing the catalogue cannot answer drops out of the wire list rather than
// 500ing every card riding along with it.
export const REQUESTS = {
  sum: [
    'sleep_asleep_minutes', 'sleep_deep_minutes', 'sleep_light_minutes', 'sleep_rem_minutes',
    'sleep_awake_minutes', 'sleep_in_bed_minutes', 'sleep_nap_minutes',
  ],
  last: ['sleep_efficiency', 'sleep_bedtime_minutes', 'sleep_waketime_minutes'],
  count: ['sleep_nap_count'],
} as const satisfies Partial<Record<DailyAgg, readonly string[]>>

function under(agg: keyof typeof REQUESTS): string[] {
  return REQUESTS[agg].filter((metric) => METRICS[metric]?.aggs.includes(agg) ?? false)
}

const SUM_METRICS = under('sum')
const LAST_METRICS = under('last')
const COUNT_METRICS = under('count')

const GROUPS: readonly MetricGroup[] = [
  { agg: 'sum', metrics: SUM_METRICS, covers: REQUESTS.sum },
  { agg: 'last', metrics: LAST_METRICS, covers: REQUESTS.last },
  { agg: 'count', metrics: COUNT_METRICS, covers: REQUESTS.count },
]

const values = (points: SeriesPoint[]): number[] =>
  points.map((p) => p.value).filter((v): v is number => v !== null)

// Every sum-agg and last-agg card on this page states a typical night, not a running total: a
// month's worth of minutes asleep added together reads as "210h asleep this month", which answers
// a question nobody asked, where the mean nightly figure is the number a sleeper actually wants.
// Only the two nap metrics differ (see their own card calls below), because a nap is episodic
// rather than nightly and a total over the period is the more useful reading, the same choice
// Activity.tsx already made for workout_count and workout_minutes.
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let cursor = Date.parse(`${from}T00:00:00Z`); cursor <= end; cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10))
  }
  return dates
}

// Hypnogram's own Stage type lives in the July fixtures module, which this page cannot import
// (see the "does not import the fixtures" test): a local, structurally identical union avoids
// that import for the one type this file needs from it. The same substitution Dashboard.tsx makes
// for the same reason.
type Stage = 'deep' | 'light' | 'rem' | 'awake'

const EMPTY_NIGHTS: Night[] = Object.freeze([]) as never[]
const EMPTY_NAPS: number[] = Object.freeze([]) as never[]

function bandFrom(baseline: Baseline | null): { low: number, high: number } | undefined {
  // Thin stays undefined, not a band drawn thin: a band computed from three nights looks exactly
  // as authoritative as one computed from thirty, and thin is the reader's only signal that it is
  // not. Same reasoning as Recovery.tsx's own bandFrom.
  return baseline !== null && !baseline.thin
    ? { low: baseline.center - baseline.spread, high: baseline.center + baseline.spread }
    : undefined
}

/**
 * The clause sleep_asleep_minutes' basis line states the deviation through, formatted as a
 * duration rather than Recovery's plain number: this page's only baselined metric is a duration,
 * and "below the 385 to 452 baseline" means nothing next to "below the 6h 25m to 7h 32m baseline".
 * Page owned rather than shared with Recovery.baselineNote, the same non-sharing Recovery.tsx and
 * Activity.tsx already carry their own copies of datesBetween under.
 */
function baselineNote(
  t: Translate, minutes: number, query: UseQueryResult<{ baseline: Baseline | null }>, on: string,
): string {
  if (query.isError) return t('sleep.baselineNote.unknown')
  // Same ordering, and the same reason, as Recovery.tsx's own baselineNote: pending has to be
  // ruled out before the null test, or an in flight request renders as "no baseline yet".
  if (query.isPending) return t('sleep.baselineNote.pending')
  const raw = query.data?.baseline ?? null
  if (raw === null) return t('sleep.baselineNote.none')
  if (raw.thin) return t('sleep.baselineNote.thin', { on })
  const low = raw.center - raw.spread
  const high = raw.center + raw.spread
  if (minutes < low) return t('sleep.baselineNote.below', { low: formatDuration(low), high: formatDuration(high) })
  if (minutes > high) return t('sleep.baselineNote.above', { low: formatDuration(low), high: formatDuration(high) })
  return t('sleep.baselineNote.within', { low: formatDuration(low), high: formatDuration(high) })
}

export function Sleep() {
  const { t, i18n } = useTranslation()
  const session = useSession()
  const controls = usePageControls()
  const period = `${controls.from} ${t('common.to')} ${controls.to}`

  // Pinned to the all sources sentinel for the same reason as every sibling page: a per source
  // rollup carries no sourceMix (only a merged row does), so reading the selector's own options
  // off a request scoped to whatever the reader picked would go empty the moment a device filter
  // became active.
  const sourceEnumeration = useSeries([...SUM_METRICS], { from: controls.from, to: controls.to, source: ALL_SOURCES }, 'sum')
  const sources = distinctSources([sourceEnumeration])
  // Off the same all-sources enumeration the selector is built from, so this costs no
  // request of its own: the mix is already on the points that query returned.
  const stoppedSources = sourcesStoppedInRange([sourceEnumeration], controls.to)
  const source = resolveSource(controls.source, [ALL_SOURCES, ...sources])
  const range = { from: controls.from, to: controls.to, source }
  const resolved = { ...controls, source }

  // The day and metric a chart's own click named, or null when no panel is open. Same single slot
  // Dashboard.tsx's own copy of this state uses, and the same reason: only one panel is ever open.
  const [annotateTarget, setAnnotateTarget] = useState<AnnotateTarget | null>(null)
  const overridesQuery = useAnnotations(range)
  // Grouped once per render of the overrides list, not once per card: see chartAnnotations.ts's
  // own comment on why Map.get keeps every chart's annotations/excluded arrays stable across a
  // render that did not change the overrides list.
  const overridesByMetricMap = useMemo(
    () => overridesByMetric(overridesQuery.overrides.data?.items ?? []),
    [overridesQuery.overrides.data],
  )
  // Notes and events, day level rather than metric scoped, reaching every card on this page alike:
  // see useDayAnnotations' own comment for why both memos live there now, not copied per page.
  const { dayAnnotations, dayAnnotationsByMetric } =
    useDayAnnotations(overridesQuery.notes, overridesQuery.events, overridesByMetricMap)

  const metricGroups = useMetricGroups(GROUPS, range)
  const sumSeries = metricGroups.queryForAgg('sum')
  const lastSeries = metricGroups.queryForAgg('last')
  const countSeries = metricGroups.queryForAgg('count')

  // Only sleep_asleep_minutes carries a baseline, matching the fixture era page this replaces,
  // which compared only the one night's total sleep against a range and left the stage totals
  // and nap unbaselined. 'sum' explicitly, the same reason Recovery.tsx passes 'last' rather than
  // the default: this metric's only agg is sum, and a caller that could not vary it would be one
  // catalogue change away from asking for an agg the metric does not have.
  // historicalTo, not controls.to: see Dashboard.tsx's own hrBaseline comment for why a Month or
  // Year view's calendar end is not the same date as the last day that has actually happened.
  const asleepBaseline = useBaseline('sleep_asleep_minutes', controls.historicalTo, source, 'sum')
  const asleepBand = useMemo(() => bandFrom(asleepBaseline.data?.baseline ?? null), [asleepBaseline.data])

  // The one insight card the brief's own table gives this page: sleep_asleep_minutes at the sum
  // agg the time asleep tile above already requests (REQUESTS.sum). /insights is its own,
  // unbatched request, so this is one call added on top of the three agg groups above. `to` is
  // historicalTo for the same reason asleepBaseline above reads it: see Dashboard.tsx's own
  // insightRange comment.
  const asleepInsight = useInsight('sleep_asleep_minutes', 'sum', { from: controls.from, to: controls.historicalTo }, source)

  // Hypnogram: /sleep/nights through useNights, not the eleven cards' own /series groups above.
  // Stays outside MetricCard: its emptiness is "lastNight === null" off useNights, not a metric and
  // a points array MetricCard's own emptyStateFor could read. Follows Dashboard's own hand rolled
  // Card, including its error-before-pending order.
  const nights = useNights(range)
  const nightItems = nights.data?.items ?? EMPTY_NIGHTS
  const lastNight = useMemo(() => oneNightPerDate(nightItems).at(-1) ?? null, [nightItems])

  // startMs/endMs stay raw milliseconds from the night's own start, not rounded to a minute here:
  // Hypnogram's own stageTotals sums these to build the totals row beneath the chart, and rounding
  // each boundary to a minute before that sum ran let the two roundings (a boundary, then a total)
  // compound into several minutes of drift against derive/sleep.ts's own single-rounded figure.
  // See Hypnogram.tsx's own comment on its `segments` prop for the mechanism.
  const hypnogramSegments = useMemo(() => (lastNight === null ? [] : lastNight.segments
    .map((s) => ({
      stage: stageOf(s.stage),
      startMs: s.startMs - lastNight.startMs,
      endMs: s.endMs - lastNight.startMs,
    }))
    .filter((s): s is { stage: Stage, startMs: number, endMs: number } => s.stage !== null)), [lastNight])
  // The night's own start, which is the bedtime: readSleepNights splits each date through
  // assembleNights, so lastNight.startMs is where the night began and not merely the earliest
  // instant sharing its date, and an afternoon nap on that date sits in `naps` instead. This
  // label used to read "Bed 13:00" for exactly that nap, which is why it is worth saying what
  // feeds it now. Still computed from the night's instants rather than deferred to
  // sleep_bedtime_minutes, the way the schedule card below reads its bed times: the hypnogram
  // beside this label is drawn from those same instants, and a label sourced from anywhere else
  // could disagree with the bar it labels.
  const lastNightBedMinutes = lastNight === null
    ? null : inWindow(localMinutesOf(lastNight.localDate, lastNight.startMs, lastNight.startOffsetMinutes), WIDE_WINDOW)
  const hypnogramStartLabel = lastNightBedMinutes !== null
    ? t('common.bedLabel', { time: formatClock(lastNightBedMinutes) })
    : t('common.bedTimeNotRecorded')

  // Nap clock times, the one thing this card cannot get from a metric: sleep_nap_count and
  // sleep_nap_minutes carry a count and a duration, never a time of day, so the markers come off
  // /sleep/nights (already fetched above for the hypnogram) while bed and wake stay on the two
  // derived metrics below. The two agree on one condition, not by construction: readSleepNights
  // splits each date through the same assembleNights that sleep_bedtime_minutes and
  // sleep_waketime_minutes are pushed from, so a night's span there and the pair here are the same
  // group and the naps are exactly what that group excluded, but only while nightGapMinutes is the
  // same on both sides of that split. readSleepNights reads the instance's own setting at query
  // time and says why in its own words ("a night assembled at one gap and read back at another is
  // two different nights", packages/core/src/query/sleepNights.ts); the metrics were pushed at
  // whatever gap was in force when the derivation last ran. Change that setting without a rebuild
  // and this card's bed, wake and naps stop describing one grouping, which is a stale derivation
  // rather than a defect here, and not something this page can detect.
  //
  // endOffsetMinutes, not startOffsetMinutes: a night starts the evening before the date it
  // belongs to, and a nap falls on the date itself, the same side of midnight as the wake, so the
  // wake end's offset is the one in force when the nap started.
  //
  // Raw minutes from that date's own midnight, not yet placed on any axis: which axis position a
  // nap takes depends on the shift the night on its row was drawn with, which lives in
  // scheduleNights below (napInWindow, and its own comment in schedule.ts for why inWindow is the
  // wrong function here and was off by a full day for every afternoon nap).
  const napsByDate = useMemo(() => {
    const out = new Map<string, number[]>()
    for (const night of oneNightPerDate(nightItems)) {
      out.set(night.localDate, night.naps.map(
        (ms) => localMinutesOf(night.localDate, ms, night.endOffsetMinutes),
      ))
    }
    return out
  }, [nightItems])

  // Sleep schedule: sleep_bedtime_minutes and sleep_waketime_minutes (already fetched above, as
  // part of LAST_METRICS), not /sleep/nights. Dashboard.tsx's own schedule card comment explains
  // why at length: /sleep/nights groups every sleep session sharing a date and source into one row,
  // so a startMs/endMs span drawn from it includes any nap that landed on the same local date,
  // where sleep_bedtime_minutes/sleep_waketime_minutes are pushed from the `night` group
  // assembleNights already separated from `naps` and carry no such contamination. Reading nights
  // directly here, the way an earlier version of this card did, widened the axis enough to draw a
  // nap-contaminated span with confidence instead of suppressing it as no data: a real 23:20 to
  // 07:05 night sharing its local date with an unrelated 13:00-17:00 nap drew as a single, wrong,
  // 17h40 "night" spanning bed to the nap's own end. That span is the night alone now, so the
  // choice is no longer forced; the pair stays because it is the same value the eleven cards
  // around this one already read, one request rather than two answering for one chart.
  //
  // Stays outside MetricCard even so: two metrics
  // zipped by date is not one metric's own points array, the same reasoning Dashboard's own
  // schedule card states for why it hands MetricCard a concatenation rather than one metric name
  // (its basisPlacement differs from this page's hand rolled Card only in which component owns the
  // Card shell, not in what it reads).
  const bedtimePoints = metricGroups.pointsOf('sleep_bedtime_minutes')
  const waketimePoints = metricGroups.pointsOf('sleep_waketime_minutes')
  const scheduleNights = useMemo(() => {
    const bedtimeByDate = new Map(bedtimePoints.map((p) => [p.localDate, p]))
    const waketimeByDate = new Map(waketimePoints.map((p) => [p.localDate, p]))
    const dates = [...new Set([...bedtimeByDate.keys(), ...waketimeByDate.keys()])].sort()
    return dates.map((date) => {
      const bedPoint = bedtimeByDate.get(date)
      const wakePoint = waketimeByDate.get(date)
      // WIDE_WINDOW, the axis change this task is for: the noon to noon default (top at 2160, noon
      // the next day) cannot hold a night running past its own far noon, such as 20:00 to 22:00 the
      // day after (26 hours: bed lands at 1200, wake at 2760, past the default's own 2160 edge but
      // inside the wide window's 2880 one, see withinSchedule and schedule.test.ts for the general
      // case). That is a defensible corner on Dashboard's compact card and the wrong trade on the
      // page whose entire subject is sleep.
      const bedRaw = bedPoint ? bedPoint.value : null
      const wakeRaw = wakePoint ? wakePoint.value : null
      const { bed, wake } = withinSchedule(bedRaw, wakeRaw, WIDE_WINDOW)
      // EMPTY_NAPS for a date /sleep/nights reported no night for at all, which is a date this
      // list can only reach through a bedtime metric whose own sessions would have produced one.
      // Every other date's naps are shifted into the frame this row's own night was drawn in, off
      // the raw bedtime (or the raw wake time, when only that one answered) rather than off the
      // placed pair: withinSchedule nulls both out for a night this window cannot hold, and the
      // naps on such a row are still real times of day that belong beside its absence mark.
      const napsRaw = napsByDate.get(date)
      return {
        date, bed, wake,
        naps: napsRaw === undefined
          ? EMPTY_NAPS
          : napsRaw.map((raw) => napInWindow(raw, bedRaw ?? wakeRaw, WIDE_WINDOW)),
      }
    })
  }, [bedtimePoints, waketimePoints, napsByDate])
  // Nights actually drawn, not nights fetched: withinSchedule nulls out any night this window
  // cannot place honestly and SleepSchedule draws those as its own absence mark, so counting dates
  // would claim a bed and wake time for a row that shows neither. Same reasoning as Dashboard's own
  // drawnNights.
  const drawnNights = scheduleNights.filter((n) => n.bed !== null && n.wake !== null).length

  const personId = session.data?.personId
  const exportPath = personId !== undefined ? exportPathFor(personId, SUM_METRICS, 'sum', range) : undefined

  // Every calendar day in the range, the axis the sparklines below are built along as well as the
  // denominator every basis line counts against. Declared ahead of them rather than after, which is
  // where it used to sit, because they are built against it now.
  const rangeDates = useMemo(() => datesBetween(controls.from, controls.to), [controls.from, controls.to])

  // Stable array identities for the reason every sibling page's own copy of this memo states:
  // useChart keys its rebuild on `build`, itself a useCallback over `values`, so a freshly
  // constructed array on every render disposes and reinitialises the chart.
  const sparklines = useMemo(() => {
    const out = new Map<string, { values: (number | null)[], labels: string[] }>()
    for (const metric of [...SUM_METRICS, ...LAST_METRICS, ...COUNT_METRICS]) {
      const points = metricGroups.pointsOf(metric)
      // denseSeries, not points.map: /series omits a day nothing reported, and an applied
      // exclusion is exactly such a day (deriveDay deletes the excluded metric's daily row).
      // Handed the points array directly, a sparkline had no position for that day at all, so its
      // excluded mark, the reason beside it and its accessible table row all vanished the moment
      // the exclusion took effect. Dense over the range the reader asked for, the same shape the
      // heart rate range chart and the heatmap have always been handed, the gap is a position
      // that can be marked.
      out.set(metric, denseSeries(rangeDates, points))
    }
    return out
  }, [rangeDates, sumSeries.data, lastSeries.data, countSeries.data])

  // Every sparkline tile on this page shares one shape: a metric, a headline the caller has
  // already computed (mean for a typical night, sum for the two episodic nap metrics), and a
  // basis line stating how many of the range's nights answered. basisWornKey is handed the same
  // string as basisKey, not a distinct wear-clause template: no sleep metric carries a wear signal
  // (packages/core/src/query/coverageSignal.ts's own list is built from DATA_TYPES' intraday
  // tier, and the sleep family has no data type of its own to appear in it), so MetricCard's wear
  // branch can never fire for any card on this page, the same reasoning Recovery.tsx's own card()
  // states for its three metrics.
  const tile = (
    metric: string, span: number, label: string, basisKey: string, chartLabelKey: string,
    value: string, unitKey: string, shortUnit: string | undefined, polarity: Polarity,
    extra: Record<string, unknown> = {}, band?: { low: number, high: number },
  ) => {
    const points = metricGroups.pointsOf(metric)
    const spark = sparklines.get(metric)!
    const { excluded } = annotationsFor(overridesByMetricMap, metric)
    const annotations = annotationsWithDay(dayAnnotationsByMetric, dayAnnotations, metric)
    return (
      <MetricCard metric={metric} span={span} basisPlacement="body" query={metricGroups.queryFor(metric)} points={points}
        oneDayRange={controls.tab === 'day'}
        basisKey={basisKey} basisWornKey={basisKey} basisValues={{ total: rangeDates.length, ...extra }}>
        {(basis, oneDayRange) => (
          <StatTile label={label} value={value} unit={shortUnit} basis={basis}
            delta={deltaFor(t, metric, values(points), polarity)}>
            {oneDayRange ? <ChartNote /> : (
              <Sparkline values={spark.values} labels={spark.labels} metric={metric}
                label={t(chartLabelKey, { period })} unit={t(unitKey)} baseline={band}
                annotations={annotations} excluded={excluded}
                onPointClick={(localDate) => setAnnotateTarget({ scope: 'day_metric', localDate, metric })} />
            )}
          </StatTile>
        )}
      </MetricCard>
    )
  }

  const asleepPoints = metricGroups.pointsOf('sleep_asleep_minutes')
  const asleepMean = mean(values(asleepPoints))

  // The sleep balance card's own memos, declared after asleepPoints because that is the array they
  // read, and both keyed on their real inputs for the reason every sibling memo on this page
  // states: a freshly constructed array on every render disposes and reinitialises the chart
  // underneath it (chart-lifecycle.test.tsx).
  //
  // The zero line the whole card hangs off. Two lines rather than one, deliberately: a person with
  // no history has no usual to be measured against and eight hours is a real number on day one, so
  // the target stands in until the baseline is worth standing on. `thin` is the app's own signal
  // for that rather than a second threshold invented here: Sleep.tsx's own bandFrom withholds a
  // band on exactly this flag for exactly this reason, and the crossover is 42 recorded nights in
  // the trailing 60 day window (baseline.ts's `n < 14 || n / 60 < 0.7`, and a window that ends the
  // day before the anchor, so the anchor day itself is never part of the baseline it is scored
  // against, but a multi-day range does overlap it: on a week anchored at 2026-08-16 the window
  // covers 2026-06-18 to 08-15 and six of the seven nights being scored contributed to it. A short
  // night therefore pulls the line down and shrinks its own reported deficit by that share, which
  // is accepted here to keep the anchor on historicalTo like every other baseline in the app
  // rather than on the range start, where a Year view would measure against a year-old usual).
  //
  // Unless the reader switched the baseline off in Settings, in which case the stored target is
  // the zero line always, even behind a solid baseline, for whoever wants to hold a seven or
  // eight hour line on purpose. The switch defaults to on, so a reader who never opened Settings
  // gets the baseline behaviour rather than a flat target they never chose.
  //
  // While the baseline request is in flight the target is used, which is the same answer as a thin
  // or absent one and needs no third branch: nothing here waits on a query that is already mounted
  // on this page, and the basis line below names which of the two is in force, because "8h short of
  // 8h" and "1h below your usual" are different claims and a card that silently swapped between
  // them would state a number with no meaning attached.
  //
  // historicalTo, not controls.to, and the same anchor asleepBaseline above is fetched with: a
  // Month or Year view's calendar end is not the same date as the last day that has actually
  // happened.
  const balanceZeroLine = useMemo(() => {
    const baseline = asleepBaseline.data?.baseline ?? null
    const followBaseline = session.data?.sleepUseBaseline ?? true
    if (followBaseline && baseline !== null && !baseline.thin) {
      return { minutes: baseline.center, source: 'baseline' as const }
    }
    return { minutes: session.data?.sleepTargetMinutes ?? DEFAULT_SLEEP_TARGET_MINUTES, source: 'target' as const }
  }, [asleepBaseline.data, session.data?.sleepTargetMinutes, session.data?.sleepUseBaseline])

  // The signed deviation of each night in the range, dense: a night that reported nothing keeps its
  // position and draws no bar, and an excluded night is the same shape rather than a special case,
  // because deriveDay deletes the excluded metric's daily row and /series then omits the day
  // entirely. Neither is read as a zero, which would draw as a night of exactly no surplus, and
  // neither counts toward the headline or the denominator below: absent is not a number here.
  const balance = useMemo(() => {
    const dense = denseSeries(rangeDates, asleepPoints)
    return {
      labels: dense.labels,
      values: dense.values.map((value) => (value === null ? null : value - balanceZeroLine.minutes)),
    }
  }, [rangeDates, sumSeries.data, balanceZeroLine.minutes])

  // Sum, not mean: the card's own subject is the surplus or deficit over the period, and the basis
  // line already states the night count it was taken over, so dividing by it here would answer a
  // question nobody asked twice. A year's 365 nights against the mean of the trailing 60 days
  // makes this a large number by construction, which is the deliberate choice rather than an
  // accident: it reads as a year's running surplus against that recent usual, and the basis line
  // names the window it was taken over so a Year tab does not make the same claim as a Week tab
  // without saying so.
  const balanceTotal = balance.values.reduce((total: number, value) => (value === null ? total : total + value), 0)

  // The points MetricCard counts its own basis line from: the metric's own rows, narrowed to the
  // dates this chart actually drew. Handed the raw `asleepPoints` it would count days outside the
  // range the reader asked for, and the basis and the bars would then state two different night
  // counts for one card. Written as the same denseSeries invariant the chart is built along rather
  // than as an arbitrary filter, so "a point the chart has a bar for" and "a point the basis line
  // counted" are the same predicate.
  //
  // Memoised, and read by the balance memo above rather than recomputed inside it, because both are
  // `build`'s dependency chain one level down (chart-lifecycle.test.tsx).
  const balancePoints = useMemo(() => {
    const byDate = new Map(asleepPoints.map((point) => [point.localDate, point]))
    return balance.labels.map((date) => byDate.get(date)).filter((point) => point !== undefined)
  }, [sumSeries.data, balance.labels])

  // The per-night mean, and what lets the headline stay a cumulative total. A signed sum is the
  // right subject for the card, but it grows by widening the picker alone, so a Year tab's figure
  // says as much about the range as about the sleep in it. Stating both is the answer rather than
  // switching framing at some tab: the big number stays the period's running balance and this sits
  // beside the night count underneath it, where a reader comparing a week to a year has one figure
  // that does not move with the window.
  //
  // Over the nights actually drawn, not the days in the range, which is the same denominator the
  // basis line's own `reported` counts (MetricCard takes it from `points`, and `balancePoints` is
  // what it is handed). A silent night is absent from both, so it drags this toward neither zero
  // nor anything else, the rule the rest of the card is built on.
  //
  // Null rather than zero for an empty range, because the mean of no nights is not a number.
  // MetricCard hides the whole card on that input, but this is computed before it decides, so
  // without the guard a NaN would reach formatSignedDuration instead of its absent branch.
  const balancePerNight = balancePoints.length === 0 ? null : balanceTotal / balancePoints.length

  // No local "nothing readable in the range" gate, and its absence is deliberate rather than an
  // omission. The rule is that the card renders nothing at all rather than an empty shell,
  // and routing this card through MetricCard is what delivers it: every night absent means
  // `asleepPoints` is empty, which is MetricCard's own no_data branch, which hides the Card. There
  // is no second shape to catch, either. A card that kept a point with no value behind it would be
  // one MetricCard could not see, and the range whose every night the reader excluded is not that
  // shape: an applied exclusion deletes the metric's daily row at derivation (see the balance memo
  // above), so the day leaves `points` along with its value. A guard here would be code no input
  // could reach, which is why it is not here.
  //
  // The same pair the sparkline tiles above take, through the same two helpers, so an excluded
  // night is a drawn, named gap here rather than a silent one: a table cell reading "excluded"
  // beside a canvas showing nothing at all is the two channel divergence this project treats as a
  // defect. The metric is this card's own, so an override scoped to sleep_asleep_minutes reaches
  // it and an override scoped to another metric does not.
  const { excluded: balanceExcluded, annotations: balanceAnnotations } =
    annotationsFor(overridesByMetricMap, 'sleep_asleep_minutes')
  // historicalTo, not controls.to: this is the date asleepBaseline was actually anchored on above,
  // and the note has to name the date the band was really computed against, the same invariant
  // Dashboard.tsx's own hrBaseline comment states.
  const asleepNote = baselineNote(t, asleepMean, asleepBaseline, controls.historicalTo)

  const efficiencyMean = mean(values(metricGroups.pointsOf('sleep_efficiency')))
  const bedtimeMean = mean(values(metricGroups.pointsOf('sleep_bedtime_minutes')))
  const waketimeMean = mean(values(metricGroups.pointsOf('sleep_waketime_minutes')))
  const napCountTotal = sum(values(metricGroups.pointsOf('sleep_nap_count')))
  const napMinutesTotal = sum(values(metricGroups.pointsOf('sleep_nap_minutes')))

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('sleep.title')}</h1>
      <ControlRow controls={resolved} sources={sources} exportPath={exportPath} trendNote
        stoppedSources={stoppedSources} />
      <CardGrid>
        {/* Not a MetricCard: gated on a night from useNights, not a metric and its points, the
            same reason Dashboard's own hypnogram card stays outside it. The date names the night
            actually drawn, never the range end, so an empty range never claims a night it has no
            row for.
            Nothing at all rather than an empty Card, the same rule MetricCard's own no_data
            branch follows: the shell is what reports presence to CardGrid, so an empty one would
            keep the page claiming it has something to show. The error and pending cards stay,
            since neither is a statement about the person's record. */}
        {nights.isError || nights.isPending || lastNight !== null ? (
          <Card span={7} label={t('sleep.sleepStages.label')}
            basis={nights.isError || lastNight === null
              ? undefined
              : t('sleep.sleepStages.basis', { date: lastNight.localDate })}>
            {nights.isError ? <ErrorState onRetry={() => void nights.refetch()} error={nights.error} />
              // lastNight && (...), not a bare fragment: the outer gate above already guarantees
              // lastNight is non-null whenever this branch runs, but that guarantee lives in a
              // sibling condition TypeScript's narrowing does not reach back through, so the check
              // is repeated here, right beside the read, for the narrowing itself.
              : nights.isPending ? <Loading /> : lastNight && (
              <>
                <Hypnogram segments={hypnogramSegments} startLabel={hypnogramStartLabel} startClock={lastNightBedMinutes}
                  label={t('sleep.sleepStages.chartLabel', { date: lastNight.localDate })} />
                <NightExcludedSessions count={lastNight.excludedSessions.length} />
              </>
            )}
          </Card>
        ) : null}
        {/* Gated on lastSeries, the 'last' agg group sleep_bedtime_minutes/sleep_waketime_minutes
            ride in, not on the nights query: bed and wake come from that pair, and a card that
            can draw them should not sit behind a second request that only adds the nap markers.
            showNaps follows that second request rather than being fixed either way, because the
            naps column states that a check was made: with the nights query still in flight or
            failed there are no nap times to have checked, and a column of "none" would claim
            otherwise for every night in the range.
            axisWindow is the wide one: see scheduleNights' own comment for why.
            Nothing at all rather than an empty Card, the same rule MetricCard's own no_data
            branch follows: the shell is what reports presence to CardGrid, so an empty one would
            keep the page claiming it has something to show. The error and pending cards stay,
            since neither is a statement about the person's record. */}
        {lastSeries.isError || lastSeries.isPending || scheduleNights.length > 0 ? (
          <Card span={5} label={t('sleep.sleepSchedule.label')}
            basis={lastSeries.isError || scheduleNights.length === 0
              ? undefined
              : t('sleep.sleepSchedule.basis', { count: drawnNights })}>
            {lastSeries.isError ? <ErrorState onRetry={() => void lastSeries.refetch()} error={lastSeries.error} />
              : lastSeries.isPending ? <Loading /> : (
              <SleepSchedule nights={scheduleNights} showNaps={nights.isSuccess}
                label={t('common.bedWakeChartLabel', { period })} />
            )}
          </Card>
        ) : null}

        {/* The sleep balance card: the period's running surplus or deficit, one bar per night
            against a zero line that is the person's own usual once that is worth standing on and
            their stored target until it is.

            Placed after the two summary cards and before the first tile row, so the period's own
            reading comes before the per-metric tiles that break it down. Span 4, the bedtime
            and efficiency tiles' own width: the card states one headline and one chart, and a
            wider card would give that single number more weight than the tiles beside it.

            Routed through MetricCard rather than hand rolled, which is what buys the pending, the
            error, the not_synced and the no_data branches in one place, and is also what keeps
            card-gating-guard.test.ts green. That routing is what makes the card render nothing at
            all rather than an empty shell when no night in the range is readable: every night
            absent leaves `balancePoints` empty, which is MetricCard's own no_data branch, which
            hides the Card rather than leaving a shell that would still report itself present to
            CardGrid. `oneDayRange` swaps the chart for ChartNote on the Day tab: a single diverging
            bar says nothing the headline does not. */}
        {/* No label on the MetricCard itself, the same as every tile above: the title lives in
            the StatTile below, so Card renders no header of its own and the error and pending
            branches keep the same chrome as their neighbours rather than a titled shell beside
            untitled ones. No unit beside the headline either: formatSignedDuration already reads
            "2h 15m", so a "Minutes" after it would state the unit twice. The bedtime and wake
            time tiles above omit theirs for the same reason, and for the same reason this card
            carries no delta: the headline is already a signed figure, and a change computed over
            it would be noise. */}
        <MetricCard metric="sleep_asleep_minutes" span={4} basisPlacement="body"
          query={metricGroups.queryFor('sleep_asleep_minutes')} points={balancePoints}
          basisKey={balanceZeroLine.source === 'baseline' ? 'sleep.balance.basisBaseline' : 'sleep.balance.basisTarget'}
          basisWornKey={balanceZeroLine.source === 'baseline' ? 'sleep.balance.basisBaseline' : 'sleep.balance.basisTarget'}
          basisValues={{ total: rangeDates.length, target: formatDuration(balanceZeroLine.minutes),
            on: controls.historicalTo, perNight: formatSignedDuration(balancePerNight, '') }}
          oneDayRange={controls.tab === 'day'}>
          {(basis, oneDayRange) => (
            <StatTile label={t('sleep.balance.label')} value={formatSignedDuration(balanceTotal, '')} basis={basis}>
              {oneDayRange ? <ChartNote /> : (
                <BalanceBars values={balance.values} labels={balance.labels}
                  label={t('sleep.balance.chartLabel', { period })}
                  unit={t('sleep.balance.columnUnit')}
                  annotations={balanceAnnotations} excluded={balanceExcluded}
                  onPointClick={(localDate) => setAnnotateTarget({
                    scope: 'day_metric', localDate, metric: 'sleep_asleep_minutes',
                  })} />
              )}
            </StatTile>
          )}
        </MetricCard>
        {/* A night list, mirroring Activity's own SessionList, with each row a link into the night
            detail page. Directly under the two charts and the balance card rather than at the foot
            of the page where it used to sit: the nights are the most specific thing this page
            holds, and eleven aggregate tiles in front of them made a reader scroll past every
            average to reach the individual nights those averages are made of. `resolved`, not the
            raw `controls`: every other query on this page reads through `resolved` for the reason
            stated where it is built above (a source named in the URL that this person's own series
            responses have never reported has to fall back to the all sources sentinel), and
            `Activity.tsx` mounts its own SessionList with `resolved` for that identical reason. A
            night list built from the unresolved value would query a source the control row above it
            is not showing, so the two would read as two different periods for the one page. */}
        <Card span={12} label={t('sleep.nights.label')}>
          <NightList controls={resolved} />
        </Card>

        {tile('sleep_asleep_minutes', 4, t('sleep.asleepMinutes.label'), 'sleep.asleepMinutes.basis',
          'sleep.asleepMinutes.chartLabel', formatDuration(asleepMean), 'sleep.units.minutes', undefined,
          'higher-is-better', { note: asleepNote }, asleepBand)}
        {tile('sleep_efficiency', 4, t('sleep.efficiency.label'), 'sleep.efficiency.basis',
          'sleep.efficiency.chartLabel', formatMetricValue(efficiencyMean, 'sleep_efficiency', i18n.language, ''),
          'sleep.units.percent', t('sleep.units.percentShort'), 'higher-is-better')}
        {tile('sleep_in_bed_minutes', 4, t('sleep.inBedMinutes.label'), 'sleep.inBedMinutes.basis',
          'sleep.inBedMinutes.chartLabel', formatDuration(mean(values(metricGroups.pointsOf('sleep_in_bed_minutes')))),
          'sleep.units.minutes', undefined, 'neutral')}

        {tile('sleep_deep_minutes', 4, t('sleep.stage.deep'), 'sleep.deepMinutes.basis',
          'sleep.deepMinutes.chartLabel', formatDuration(mean(values(metricGroups.pointsOf('sleep_deep_minutes')))),
          'sleep.units.minutes', undefined, 'higher-is-better')}
        {tile('sleep_light_minutes', 4, t('sleep.stage.light'), 'sleep.lightMinutes.basis',
          'sleep.lightMinutes.chartLabel', formatDuration(mean(values(metricGroups.pointsOf('sleep_light_minutes')))),
          'sleep.units.minutes', undefined, 'neutral')}
        {tile('sleep_rem_minutes', 4, t('sleep.stage.rem'), 'sleep.remMinutes.basis',
          'sleep.remMinutes.chartLabel', formatDuration(mean(values(metricGroups.pointsOf('sleep_rem_minutes')))),
          'sleep.units.minutes', undefined, 'higher-is-better')}

        {tile('sleep_awake_minutes', 4, t('sleep.stage.awake'), 'sleep.awakeMinutes.basis',
          'sleep.awakeMinutes.chartLabel', formatDuration(mean(values(metricGroups.pointsOf('sleep_awake_minutes')))),
          'sleep.units.minutes', undefined, 'lower-is-better')}
        {tile('sleep_bedtime_minutes', 4, t('sleep.bedtimeMinutes.label'), 'sleep.bedtimeMinutes.basis',
          'sleep.bedtimeMinutes.chartLabel', formatClock(bedtimeMean), 'sleep.units.minutesFromMidnight', undefined,
          'neutral')}
        {tile('sleep_waketime_minutes', 4, t('sleep.waketimeMinutes.label'), 'sleep.waketimeMinutes.basis',
          'sleep.waketimeMinutes.chartLabel', formatClock(waketimeMean), 'sleep.units.minutesFromMidnight', undefined,
          'neutral')}

        {tile('sleep_nap_count', 4, t('sleep.napCount.label'), 'sleep.napCount.basis',
          'sleep.napCount.chartLabel', formatMetricValue(napCountTotal, 'sleep_nap_count', i18n.language, ''),
          'sleep.units.naps', t('sleep.units.napsShort'), 'neutral', { count: napCountTotal })}
        {tile('sleep_nap_minutes', 4, t('sleep.napMinutes.label'), 'sleep.napMinutes.basis',
          'sleep.napMinutes.chartLabel', formatDuration(napMinutesTotal), 'sleep.units.minutes', undefined,
          'neutral')}

        {/* label is its own catalogue string, not sleep.asleepMinutes.label ("Time asleep")
            reused: a second card sharing that exact text would make a label lookup by exact text
            ambiguous, the same collision Dashboard.tsx's own comment on INSIGHTS explains at more
            length. formatValue is formatSignedDuration (format.ts), not the bare default: the time
            asleep tile above already reads through formatDuration, and without this the card would
            print raw minutes beside a tile that reads "7h 00m"; formatSignedDuration is also what
            keeps a negative delta (a period where mean sleep fell) from printing two minus signs,
            shared with Dashboard.tsx's own copy of this card rather than a second local closure. */}
        <InsightCard insight={asleepInsight.data} query={asleepInsight} metric="sleep_asleep_minutes" span={4}
          label={t('sleep.insights.asleepMinutes')} formatValue={formatSignedDuration} polarity="higher-is-better" />
      </CardGrid>
      {annotateTarget && <AnnotatePanel target={annotateTarget} onClose={() => setAnnotateTarget(null)} />}
    </>
  )
}
