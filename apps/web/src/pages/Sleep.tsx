import { useMemo, useState } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { METRICS } from '@haelan/core/metrics'
import type { DailyAgg } from '@haelan/core/metrics'
import { useTranslation } from '../i18n/index.js'
import { StatTile } from '../components/StatTile.js'
import { MetricCard } from '../components/MetricCard.js'
import { Card } from '../components/Card.js'
import { EmptyState } from '../components/EmptyState.js'
import { Loading } from '../components/Loading.js'
import { ErrorState } from '../components/ErrorState.js'
import { ControlRow } from '../components/ControlRow.js'
import { AnnotatePanel } from '../components/AnnotatePanel.js'
import type { AnnotateTarget } from '../components/AnnotatePanel.js'
import { Sparkline } from '../charts/Sparkline.js'
import { Hypnogram } from '../charts/Hypnogram.js'
import { SleepSchedule } from '../charts/SleepSchedule.js'
import { localMinutesOf, inWindow, withinSchedule, WIDE_WINDOW } from '../charts/schedule.js'
import { usePageControls } from '../controls/usePageControls.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { useSession } from '../auth/session.js'
import { denseSeries, useSeries } from '../data/useSeries.js'
import type { SeriesPoint } from '../data/useSeries.js'
import { useBaseline } from '../data/useBaseline.js'
import type { Baseline } from '../data/useBaseline.js'
import { useSyncStatus } from '../data/useSyncStatus.js'
import { useNights } from '../data/useNights.js'
import type { Night } from '../data/useNights.js'
import { useAnnotations } from '../data/useAnnotations.js'
import { overridesByMetric, annotationsFor } from '../data/chartAnnotations.js'
import { useDayAnnotations, annotationsWithDay } from '../data/dayAnnotations.js'
import { useMetricGroups } from '../data/useMetricGroups.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { distinctSources, exportPathFor } from '../data/pageShell.js'
import { formatDuration, formatClock, deltaFor, formatMetricValue } from '../format.js'
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

// packages/core/src/derive/sleep.ts's ASLEEP_STAGES and AWAKE_STAGE are the only recognised
// segment stages ('DEEP', 'LIGHT', 'REM', 'AWAKE'); a segment carrying anything else is dropped
// (leaving a visible gap) rather than guessed at, the same reasoning Dashboard.tsx's own stageOf
// states.
function stageOf(raw: string): Stage | null {
  const known: Record<string, Stage> = { DEEP: 'deep', LIGHT: 'light', REM: 'rem', AWAKE: 'awake' }
  return known[raw] ?? null
}

const EMPTY_NIGHTS: Night[] = Object.freeze([]) as never[]
const EMPTY_NAPS: number[] = Object.freeze([]) as never[]

// /sleep/nights answers one row per (localDate, sourceId); collapsed to one per date, the longer
// session winning, the same rule and reasoning as Dashboard.tsx's own oneNightPerDate (a second
// device sharing the date is more likely a short partial recording than the source that stayed on
// through the whole night).
function oneNightPerDate(items: readonly Night[]): Night[] {
  const byDate = new Map<string, Night>()
  for (const n of items) {
    const existing = byDate.get(n.localDate)
    if (existing === undefined || (n.endMs - n.startMs) > (existing.endMs - existing.startMs)) {
      byDate.set(n.localDate, n)
    }
  }
  return [...byDate.values()].sort((a, b) => a.localDate.localeCompare(b.localDate))
}

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
  const asleepBaseline = useBaseline('sleep_asleep_minutes', controls.to, source, 'sum')
  const asleepBand = useMemo(() => bandFrom(asleepBaseline.data?.baseline ?? null), [asleepBaseline.data])

  // Hypnogram: /sleep/nights through useNights, not the eleven cards' own /series groups above.
  // Stays outside MetricCard: its emptiness is "lastNight === null" off useNights, not a metric and
  // a points array MetricCard's own emptyStateFor could read. Follows Dashboard's own hand rolled
  // Card, including its error-before-pending order.
  const nights = useNights(range)
  const nightItems = nights.data?.items ?? EMPTY_NIGHTS
  const lastNight = useMemo(() => oneNightPerDate(nightItems).at(-1) ?? null, [nightItems])

  const hypnogramSegments = useMemo(() => (lastNight === null ? [] : lastNight.segments
    .map((s) => ({
      stage: stageOf(s.stage),
      from: Math.round((s.startMs - lastNight.startMs) / 60_000),
      to: Math.round((s.endMs - lastNight.startMs) / 60_000),
    }))
    .filter((s): s is { stage: Stage, from: number, to: number } => s.stage !== null)), [lastNight])
  // Inherits the same nap contamination Dashboard.tsx's own startLabel comment documents:
  // lastNight.startMs is the earliest instant across every session sharing this night's date and
  // source, so a 13:00 nap sharing the date still becomes this label's "Bed 13:00" rather than the
  // real bedtime. Known, not fixed here, the same reason Dashboard leaves it: a clean label needs
  // this on the same sleep_bedtime_minutes derived value the schedule chart below now uses, which
  // is more than a single clock reading beside a hypnogram needs.
  const lastNightBedMinutes = lastNight === null
    ? null : inWindow(localMinutesOf(lastNight.localDate, lastNight.startMs, lastNight.startOffsetMinutes), WIDE_WINDOW)
  const hypnogramStartLabel = lastNightBedMinutes !== null
    ? t('common.bedLabel', { time: formatClock(lastNightBedMinutes) })
    : t('common.bedTimeNotRecorded')

  // Sleep schedule: sleep_bedtime_minutes and sleep_waketime_minutes (already fetched above, as
  // part of LAST_METRICS), not /sleep/nights. Dashboard.tsx's own schedule card comment explains
  // why at length: /sleep/nights groups every sleep session sharing a date and source into one row,
  // so a startMs/endMs span drawn from it includes any nap that landed on the same local date,
  // where sleep_bedtime_minutes/sleep_waketime_minutes are pushed from the `night` group
  // assembleNights already separated from `naps` and carry no such contamination. Reading nights
  // directly here, the way an earlier version of this card did, widened the axis enough to draw a
  // nap-contaminated span with confidence instead of suppressing it as no data: a real 23:20 to
  // 07:05 night sharing its local date with an unrelated 13:00-17:00 nap drew as a single, wrong,
  // 17h40 "night" spanning bed to the nap's own end. Stays outside MetricCard even so: two metrics
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
      const { bed, wake } = withinSchedule(
        bedPoint ? bedPoint.value : null, wakePoint ? wakePoint.value : null, WIDE_WINDOW,
      )
      return { date, bed, wake, naps: EMPTY_NAPS }
    })
  }, [bedtimePoints, waketimePoints])
  // Nights actually drawn, not nights fetched: withinSchedule nulls out any night this window
  // cannot place honestly and SleepSchedule draws those as its own absence mark, so counting dates
  // would claim a bed and wake time for a row that shows neither. Same reasoning as Dashboard's own
  // drawnNights.
  const drawnNights = scheduleNights.filter((n) => n.bed !== null && n.wake !== null).length

  const syncStatus = useSyncStatus()
  const syncedMinutesAgo = syncStatus.data?.lastFinishedAtMs != null
    ? Math.max(0, Math.round((Date.now() - syncStatus.data.lastFinishedAtMs) / 60_000))
    : null
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
        basisKey={basisKey} basisWornKey={basisKey} basisValues={{ total: rangeDates.length, ...extra }}>
        {(basis) => (
          <StatTile label={label} value={value} unit={shortUnit} basis={basis}
            delta={deltaFor(t, metric, values(points), polarity)}>
            <Sparkline values={spark.values} labels={spark.labels} metric={metric}
              label={t(chartLabelKey, { period })} unit={t(unitKey)} baseline={band}
              annotations={annotations} excluded={excluded}
              onPointClick={(localDate) => setAnnotateTarget({ localDate, metric })} />
          </StatTile>
        )}
      </MetricCard>
    )
  }

  const asleepPoints = metricGroups.pointsOf('sleep_asleep_minutes')
  const asleepMean = mean(values(asleepPoints))
  const asleepNote = baselineNote(t, asleepMean, asleepBaseline, controls.to)

  const efficiencyMean = mean(values(metricGroups.pointsOf('sleep_efficiency')))
  const bedtimeMean = mean(values(metricGroups.pointsOf('sleep_bedtime_minutes')))
  const waketimeMean = mean(values(metricGroups.pointsOf('sleep_waketime_minutes')))
  const napCountTotal = sum(values(metricGroups.pointsOf('sleep_nap_count')))
  const napMinutesTotal = sum(values(metricGroups.pointsOf('sleep_nap_minutes')))

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('sleep.title')}</h1>
      <ControlRow controls={resolved} sources={sources} syncedMinutesAgo={syncedMinutesAgo} exportPath={exportPath} />
      <div className="grid">
        {/* Not a MetricCard: gated on a night from useNights, not a metric and its points, the
            same reason Dashboard's own hypnogram card stays outside it. The date names the night
            actually drawn, never the range end, so an empty range never claims a night it has no
            row for. */}
        <Card span={7} label={t('sleep.sleepStages.label')}
          basis={nights.isError || lastNight === null
            ? undefined
            : t('sleep.sleepStages.basis', { date: lastNight.localDate })}>
          {nights.isError ? <ErrorState onRetry={() => void nights.refetch()} />
            : nights.isPending ? <Loading /> : lastNight === null ? (
            <EmptyState title={t('emptyState.no_data.title')} detail={t('emptyState.no_data.detail')} />
          ) : (
            <Hypnogram segments={hypnogramSegments} startLabel={hypnogramStartLabel}
              label={t('sleep.sleepStages.chartLabel', { date: lastNight.localDate })} />
          )}
        </Card>
        {/* Gated on lastSeries, the 'last' agg group sleep_bedtime_minutes/sleep_waketime_minutes
            ride in, not on the nights query the hypnogram card above uses: this card no longer
            reads /sleep/nights at all (see scheduleNights' own comment for why). showNaps=false
            because neither of those two metrics nor any other metric this page reads gives a nap
            its own clock time, only a duration (sleep_nap_minutes, already its own card below), so
            a naps column here could not be filled with anything this data actually knows.
            axisWindow is the wide one: see scheduleNights' own comment for why. */}
        <Card span={5} label={t('sleep.sleepSchedule.label')}
          basis={lastSeries.isError || scheduleNights.length === 0
            ? undefined
            : t('sleep.sleepSchedule.basis', { count: drawnNights })}>
          {lastSeries.isError ? <ErrorState onRetry={() => void lastSeries.refetch()} />
            : lastSeries.isPending ? <Loading /> : scheduleNights.length === 0 ? (
            <EmptyState title={t('emptyState.no_data.title')} detail={t('emptyState.no_data.detail')} />
          ) : (
            <SleepSchedule nights={scheduleNights} showNaps={false} axisWindow={WIDE_WINDOW}
              label={t('common.bedWakeChartLabel', { period })} />
          )}
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

        {tile('sleep_nap_count', 6, t('sleep.napCount.label'), 'sleep.napCount.basis',
          'sleep.napCount.chartLabel', formatMetricValue(napCountTotal, 'sleep_nap_count', i18n.language, ''),
          'sleep.units.naps', t('sleep.units.napsShort'), 'neutral', { count: napCountTotal })}
        {tile('sleep_nap_minutes', 6, t('sleep.napMinutes.label'), 'sleep.napMinutes.basis',
          'sleep.napMinutes.chartLabel', formatDuration(napMinutesTotal), 'sleep.units.minutes', undefined,
          'neutral')}
      </div>
      {annotateTarget && <AnnotatePanel target={annotateTarget} onClose={() => setAnnotateTarget(null)} />}
    </>
  )
}
