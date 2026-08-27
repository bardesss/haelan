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
import { deltaFor } from '../format.js'
import type { Translate, Polarity } from '../format.js'

// Recovery is one request: resting_heart_rate, daily_hrv and respiratory_rate are all `aggs:
// ['last']` in packages/core/src/derive/metrics.ts, so one group covers the whole page the way
// Dashboard.tsx's REQUESTS/under pair covers its own five. Kept as the same REQUESTS/under shape
// as Dashboard even though there is only one agg here, both so a second agg (a future card) has
// somewhere to go and so the daily_hrv/hrv distinction below is a change to one array entry rather
// than a literal buried in a hook call.
//
// It is daily_hrv, not hrv: daily_hrv is the once a day summary (aggs: ['last']), hrv is the
// intraday series (aggs: ['min', 'mean', 'max', 'count']). Swapping this constant to 'hrv' is the
// canary task 6's brief asks for, and it works precisely because of `under` below: 'hrv' has no
// 'last' in its own aggs, so `under('last')` filters it back out before it ever reaches the wire,
// the same protection that turns an unanswerable pairing into a quietly dropped card everywhere
// else on this page's sibling, Dashboard.tsx, rather than a 500 for the whole group.
export const REQUESTS = {
  last: ['resting_heart_rate', 'daily_hrv', 'respiratory_rate'],
} as const satisfies Partial<Record<DailyAgg, readonly string[]>>

function under(agg: keyof typeof REQUESTS): string[] {
  return REQUESTS[agg].filter((metric) => METRICS[metric]?.aggs.includes(agg) ?? false)
}

const LAST_METRICS = under('last')

const GROUPS: readonly MetricGroup[] = [
  { agg: 'last', metrics: LAST_METRICS, covers: REQUESTS.last },
]

const values = (points: SeriesPoint[]): number[] =>
  points.map((p) => p.value).filter((v): v is number => v !== null)

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let cursor = Date.parse(`${from}T00:00:00Z`); cursor <= end; cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10))
  }
  return dates
}

function bandFrom(baseline: Baseline | null): { low: number, high: number } | undefined {
  // Thin stays undefined, not a band drawn thin: a band computed from three days looks exactly as
  // authoritative as one computed from thirty, and thin is the reader's only signal that it is not.
  return baseline !== null && !baseline.thin
    ? { low: baseline.center - baseline.spread, high: baseline.center + baseline.spread }
    : undefined
}

/**
 * The clause the basis line states the deviation through: which of unknown / no baseline / thin /
 * below / within / above the reader's own 60 day history this card's mean falls into. A plain
 * interpolated fragment rather than a second basisKey selection (the way Dashboard's heart rate
 * range chooses an entire key by baseline state): that card sits in 'header' placement with no
 * StatTile basis line of its own to fold this into, while these three do, so one basisKey per
 * metric with a `{{note}}` slot says the same four-or-so things without needing four-or-so
 * near-duplicate basis templates per metric.
 */
function baselineNote(
  t: Translate, value: number, query: UseQueryResult<{ baseline: Baseline | null }>, precision: number, on: string,
): string {
  if (query.isError) return t('recovery.baselineNote.unknown')
  // Before the null test, not after it. /baselines is its own request and settles independently of
  // the series MetricCard gates on, so a card can be past its own pending state while this one is
  // still in flight; `data` is undefined then, and the null branch below would read that as "no
  // baseline yet", a claim about the person's history made before anything was asked.
  if (query.isPending) return t('recovery.baselineNote.pending')
  const raw = query.data?.baseline ?? null
  if (raw === null) return t('recovery.baselineNote.none')
  if (raw.thin) return t('recovery.baselineNote.thin', { on })
  const low = raw.center - raw.spread
  const high = raw.center + raw.spread
  const fmt = (n: number) => n.toFixed(precision)
  if (value < low) return t('recovery.baselineNote.below', { low: fmt(low), high: fmt(high) })
  if (value > high) return t('recovery.baselineNote.above', { low: fmt(low), high: fmt(high) })
  return t('recovery.baselineNote.within', { low: fmt(low), high: fmt(high) })
}

export function Recovery() {
  const { t } = useTranslation()
  const session = useSession()
  const controls = usePageControls()
  const period = `${controls.from} ${t('common.to')} ${controls.to}`

  // Same reasoning as Dashboard.tsx's own sourceEnumeration: pinned to the all sources sentinel so
  // picking a real device does not blank the selector that offers switching back.
  const sourceEnumeration = useSeries([...LAST_METRICS], { from: controls.from, to: controls.to, source: ALL_SOURCES }, 'last')
  const sources = distinctSources([sourceEnumeration])
  const source = resolveSource(controls.source, [ALL_SOURCES, ...sources])
  const range = { from: controls.from, to: controls.to, source }
  const resolved = { ...controls, source }

  const metricGroups = useMetricGroups(GROUPS, range)
  const lastSeries = metricGroups.queryForAgg('last')

  // One useBaseline call per card, not one shared like Dashboard's single heart_rate band: each
  // metric's history is its own, so resting heart rate's 60 days says nothing about HRV's. 'last'
  // explicitly, the same reason Dashboard passes 'mean' rather than the default 'sum': these three
  // metrics carry no other agg to compute a baseline from.
  const restingHrBaseline = useBaseline('resting_heart_rate', controls.to, source, 'last')
  const hrvBaseline = useBaseline('daily_hrv', controls.to, source, 'last')
  const respiratoryBaseline = useBaseline('respiratory_rate', controls.to, source, 'last')

  const syncStatus = useSyncStatus()
  const syncedMinutesAgo = syncStatus.data?.lastFinishedAtMs != null
    ? Math.max(0, Math.round((Date.now() - syncStatus.data.lastFinishedAtMs) / 60_000))
    : null
  const personId = session.data?.personId
  const exportPath = personId !== undefined ? exportPathFor(personId, LAST_METRICS, 'last', range) : undefined

  // Stable array identities for the same reason Dashboard.tsx's own `sparklines` memo exists:
  // useChart keys its rebuild on `build`, and `build` is a useCallback over `values`/`baseline`, so
  // a freshly constructed array or object on every render disposes and reinitialises the chart.
  const sparklines = useMemo(() => {
    const out = new Map<string, { values: (number | null)[], labels: string[] }>()
    for (const metric of LAST_METRICS) {
      const points = metricGroups.pointsOf(metric)
      out.set(metric, { values: points.map((p) => p.value), labels: points.map((p) => p.localDate) })
    }
    return out
  }, [lastSeries.data])

  const restingHrBand = useMemo(() => bandFrom(restingHrBaseline.data?.baseline ?? null), [restingHrBaseline.data])
  const hrvBand = useMemo(() => bandFrom(hrvBaseline.data?.baseline ?? null), [hrvBaseline.data])
  const respiratoryBand = useMemo(() => bandFrom(respiratoryBaseline.data?.baseline ?? null), [respiratoryBaseline.data])

  const rangeDates = useMemo(() => datesBetween(controls.from, controls.to), [controls.from, controls.to])

  // Three sparkline cards over the one 'last' group: exactly MetricCard's fit, no ancestor-basis
  // restructuring needed the way four of Dashboard's cards did. basisPlacement is 'body' at every
  // call: StatTile renders its own basis paragraph, so 'header' would print it twice, the exact
  // defect M3d-1's own review round shipped and then fixed.
  //
  // basisWornKey is handed the same string as basisKey, not a distinct wear-clause template: none
  // of these three metrics carries a wear signal (packages/core/src/api/catalogue.ts gives them no
  // tier override, so they default to 'daily' rather than 'intraday', and
  // coverageIsMeaningful/coverageIsWearSignal reads only the intraday set), so MetricCard's wear
  // branch can never fire for them. This is the same choice Dashboard.tsx's sleep schedule card
  // already made for the same reason, rather than a second, unreachable literal per metric.
  const card = (
    metric: string, labelKey: string, basisKey: string, chartLabelKey: string,
    unitKey: string, shortUnitKey: string, precision: number, polarity: Polarity,
    baselineQuery: UseQueryResult<{ baseline: Baseline | null }>, band: { low: number, high: number } | undefined,
  ) => {
    const points = metricGroups.pointsOf(metric)
    const headline = mean(values(points))
    const note = baselineNote(t, headline, baselineQuery, precision, controls.to)
    const spark = sparklines.get(metric)!
    return (
      <MetricCard metric={metric} span={4} basisPlacement="body" query={metricGroups.queryFor(metric)} points={points}
        basisKey={basisKey} basisWornKey={basisKey} basisValues={{ total: rangeDates.length, note }}>
        {(basis) => (
          <StatTile label={t(labelKey)} value={headline.toFixed(precision)} unit={t(shortUnitKey)}
            basis={basis} delta={deltaFor(t, metric, values(points), polarity)}>
            <Sparkline values={spark.values} labels={spark.labels}
              label={t(chartLabelKey, { period })} unit={t(unitKey)} baseline={band} />
          </StatTile>
        )}
      </MetricCard>
    )
  }

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('recovery.title')}</h1>
      <ControlRow controls={resolved} sources={sources} syncedMinutesAgo={syncedMinutesAgo} exportPath={exportPath} />
      <div className="grid">
        {card('resting_heart_rate', 'recovery.restingHeartRate.label', 'recovery.restingHeartRate.basis',
          'recovery.restingHeartRate.chartLabel', 'recovery.units.beatsPerMinute', 'recovery.units.bpm',
          0, 'lower-is-better', restingHrBaseline, restingHrBand)}
        {card('daily_hrv', 'recovery.dailyHrv.label', 'recovery.dailyHrv.basis',
          'recovery.dailyHrv.chartLabel', 'recovery.units.milliseconds', 'recovery.units.ms',
          0, 'higher-is-better', hrvBaseline, hrvBand)}
        {card('respiratory_rate', 'recovery.respiratoryRate.label', 'recovery.respiratoryRate.basis',
          'recovery.respiratoryRate.chartLabel', 'recovery.units.breathsPerMinute', 'recovery.units.breathsPerMinuteShort',
          1, 'neutral', respiratoryBaseline, respiratoryBand)}
      </div>
    </>
  )
}
