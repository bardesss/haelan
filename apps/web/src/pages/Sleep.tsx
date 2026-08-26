import { useMemo } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { METRICS } from '@haelan/core/metrics'
import type { DailyAgg } from '@haelan/core/metrics'
import { useTranslation } from '../i18n/index.js'
import { StatTile } from '../components/StatTile.js'
import { MetricCard } from '../components/MetricCard.js'
import { ControlRow } from '../components/ControlRow.js'
import { Sparkline } from '../charts/Sparkline.js'
import { usePageControls } from '../controls/usePageControls.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { useSession } from '../auth/session.js'
import { useSeries } from '../data/useSeries.js'
import type { SeriesPoint } from '../data/useSeries.js'
import { useBaseline } from '../data/useBaseline.js'
import type { Baseline } from '../data/useBaseline.js'
import { useSyncStatus } from '../data/useSyncStatus.js'
import { useMetricGroups } from '../data/useMetricGroups.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { distinctSources, exportPathFor } from '../data/pageShell.js'
import { formatDuration, formatClock, trend } from '../format.js'
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
  const { t } = useTranslation()
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

  const syncStatus = useSyncStatus()
  const syncedMinutesAgo = syncStatus.data?.lastFinishedAtMs != null
    ? Math.max(0, Math.round((Date.now() - syncStatus.data.lastFinishedAtMs) / 60_000))
    : null
  const personId = session.data?.personId
  const exportPath = personId !== undefined ? exportPathFor(personId, SUM_METRICS, 'sum', range) : undefined

  // Stable array identities for the reason every sibling page's own copy of this memo states:
  // useChart keys its rebuild on `build`, itself a useCallback over `values`, so a freshly
  // constructed array on every render disposes and reinitialises the chart.
  const sparklines = useMemo(() => {
    const out = new Map<string, { values: (number | null)[], labels: string[] }>()
    for (const metric of [...SUM_METRICS, ...LAST_METRICS, ...COUNT_METRICS]) {
      const points = metricGroups.pointsOf(metric)
      out.set(metric, { values: points.map((p) => p.value), labels: points.map((p) => p.localDate) })
    }
    return out
  }, [sumSeries.data, lastSeries.data, countSeries.data])

  const rangeDates = useMemo(() => datesBetween(controls.from, controls.to), [controls.from, controls.to])

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
    return (
      <MetricCard metric={metric} span={span} basisPlacement="body" query={metricGroups.queryFor(metric)} points={points}
        basisKey={basisKey} basisWornKey={basisKey} basisValues={{ total: rangeDates.length, ...extra }}>
        {(basis) => (
          <StatTile label={label} value={value} unit={shortUnit} basis={basis} delta={trend(t, values(points), polarity)}>
            <Sparkline values={spark.values} labels={spark.labels}
              label={t(chartLabelKey, { period })} unit={t(unitKey)} baseline={band} />
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
        {tile('sleep_asleep_minutes', 4, t('sleep.asleepMinutes.label'), 'sleep.asleepMinutes.basis',
          'sleep.asleepMinutes.chartLabel', formatDuration(asleepMean), 'sleep.units.minutes', undefined,
          'higher-is-better', { note: asleepNote }, asleepBand)}
        {tile('sleep_efficiency', 4, t('sleep.efficiency.label'), 'sleep.efficiency.basis',
          'sleep.efficiency.chartLabel', efficiencyMean.toFixed(0), 'sleep.units.percent', t('sleep.units.percentShort'),
          'higher-is-better')}
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
          'sleep.napCount.chartLabel', String(napCountTotal), 'sleep.units.naps', t('sleep.units.napsShort'),
          'neutral', { count: napCountTotal })}
        {tile('sleep_nap_minutes', 6, t('sleep.napMinutes.label'), 'sleep.napMinutes.basis',
          'sleep.napMinutes.chartLabel', formatDuration(napMinutesTotal), 'sleep.units.minutes', undefined,
          'neutral')}
      </div>
    </>
  )
}
