import { useMemo, useState } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { METRICS } from '@haelan/core/metrics'
import type { DailyAgg } from '@haelan/core/metrics'
import { useTranslation } from '../i18n/index.js'
import { StatTile } from '../components/StatTile.js'
import { MetricCard } from '../components/MetricCard.js'
import { InsightCard } from '../components/InsightCard.js'
import { ControlRow } from '../components/ControlRow.js'
import { AnnotatePanel } from '../components/AnnotatePanel.js'
import type { AnnotateTarget } from '../components/AnnotatePanel.js'
import { Sparkline } from '../charts/Sparkline.js'
import { usePageControls } from '../controls/usePageControls.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { useSession } from '../auth/session.js'
import { denseSeries, useSeries } from '../data/useSeries.js'
import type { SeriesPoint } from '../data/useSeries.js'
import { useBaseline } from '../data/useBaseline.js'
import type { Baseline } from '../data/useBaseline.js'
import { useInsight } from '../data/useInsight.js'
import { useSyncStatus } from '../data/useSyncStatus.js'
import { useAnnotations } from '../data/useAnnotations.js'
import { overridesByMetric, annotationsFor } from '../data/chartAnnotations.js'
import { useDayAnnotations, annotationsWithDay } from '../data/dayAnnotations.js'
import { useMetricGroups } from '../data/useMetricGroups.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { distinctSources, exportPathFor } from '../data/pageShell.js'
import { deltaFor, formatMetricValue, formatWithUnit } from '../format.js'
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
  t: Translate, value: number, query: UseQueryResult<{ baseline: Baseline | null }>,
  metric: string, language: string, on: string,
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
  // metric, not a precision threaded in by the caller: low/high are baseline arithmetic over this
  // same metric's own values, in its own stored unit, so METRICS[metric].precision (read inside
  // formatMetricValue) is always the right precision for them, the same one the headline beside
  // this note uses.
  const fmt = (n: number) => formatMetricValue(n, metric, language, '')
  if (value < low) return t('recovery.baselineNote.below', { low: fmt(low), high: fmt(high) })
  if (value > high) return t('recovery.baselineNote.above', { low: fmt(low), high: fmt(high) })
  return t('recovery.baselineNote.within', { low: fmt(low), high: fmt(high) })
}

export function Recovery() {
  const { t, i18n } = useTranslation()
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
  const lastSeries = metricGroups.queryForAgg('last')

  // One useBaseline call per card, not one shared like Dashboard's single heart_rate band: each
  // metric's history is its own, so resting heart rate's 60 days says nothing about HRV's. 'last'
  // explicitly, the same reason Dashboard passes 'mean' rather than the default 'sum': these three
  // metrics carry no other agg to compute a baseline from.
  // historicalTo, not controls.to: see Dashboard.tsx's own hrBaseline comment for why a Month or
  // Year view's calendar end is not the same date as the last day that has actually happened.
  const restingHrBaseline = useBaseline('resting_heart_rate', controls.historicalTo, source, 'last')
  const hrvBaseline = useBaseline('daily_hrv', controls.historicalTo, source, 'last')
  const respiratoryBaseline = useBaseline('respiratory_rate', controls.historicalTo, source, 'last')

  // The one insight card the brief's own table gives this page: resting_heart_rate at the last
  // agg the card above already requests (REQUESTS.last). /insights is its own, unbatched request,
  // so this is one call added on top of the group above, not multiplied against any card. `to` is
  // historicalTo for the same reason the baselines above read it: see Dashboard.tsx's own
  // insightRange comment.
  const restingHrInsight = useInsight('resting_heart_rate', 'last', { from: controls.from, to: controls.historicalTo }, source)

  const syncStatus = useSyncStatus()
  const syncedMinutesAgo = syncStatus.data?.lastFinishedAtMs != null
    ? Math.max(0, Math.round((Date.now() - syncStatus.data.lastFinishedAtMs) / 60_000))
    : null
  const personId = session.data?.personId
  const exportPath = personId !== undefined ? exportPathFor(personId, LAST_METRICS, 'last', range) : undefined

  // Every calendar day in the range, the axis the sparklines below are built along as well as the
  // denominator every basis line counts against. Declared ahead of them rather than after, which is
  // where it used to sit, because they are built against it now.
  const rangeDates = useMemo(() => datesBetween(controls.from, controls.to), [controls.from, controls.to])

  // Stable array identities for the same reason Dashboard.tsx's own `sparklines` memo exists:
  // useChart keys its rebuild on `build`, and `build` is a useCallback over `values`/`baseline`, so
  // a freshly constructed array or object on every render disposes and reinitialises the chart.
  const sparklines = useMemo(() => {
    const out = new Map<string, { values: (number | null)[], labels: string[] }>()
    for (const metric of LAST_METRICS) {
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
  }, [rangeDates, lastSeries.data])

  const restingHrBand = useMemo(() => bandFrom(restingHrBaseline.data?.baseline ?? null), [restingHrBaseline.data])
  const hrvBand = useMemo(() => bandFrom(hrvBaseline.data?.baseline ?? null), [hrvBaseline.data])
  const respiratoryBand = useMemo(() => bandFrom(respiratoryBaseline.data?.baseline ?? null), [respiratoryBaseline.data])

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
    unitKey: string, shortUnitKey: string, polarity: Polarity,
    baselineQuery: UseQueryResult<{ baseline: Baseline | null }>, band: { low: number, high: number } | undefined,
  ) => {
    const points = metricGroups.pointsOf(metric)
    const headline = mean(values(points))
    // historicalTo, not controls.to: this is the date restingHrBaseline/hrvBaseline/
    // respiratoryBaseline were actually anchored on above, and the note has to name the date the
    // band was really computed against, the same invariant Dashboard.tsx's own hrBaseline comment
    // states.
    const note = baselineNote(t, headline, baselineQuery, metric, i18n.language, controls.historicalTo)
    const spark = sparklines.get(metric)!
    const { excluded } = annotationsFor(overridesByMetricMap, metric)
    const annotations = annotationsWithDay(dayAnnotationsByMetric, dayAnnotations, metric)
    return (
      <MetricCard metric={metric} span={4} basisPlacement="body" query={metricGroups.queryFor(metric)} points={points}
        basisKey={basisKey} basisWornKey={basisKey} basisValues={{ total: rangeDates.length, note }}>
        {(basis) => (
          <StatTile label={t(labelKey)} value={formatMetricValue(headline, metric, i18n.language, '')} unit={t(shortUnitKey)}
            basis={basis} delta={deltaFor(t, metric, values(points), polarity)}>
            <Sparkline values={spark.values} labels={spark.labels} metric={metric}
              label={t(chartLabelKey, { period })} unit={t(unitKey)} baseline={band}
              annotations={annotations} excluded={excluded}
              onPointClick={(localDate) => setAnnotateTarget({ localDate, metric })} />
          </StatTile>
        )}
      </MetricCard>
    )
  }

  // The resting heart rate card above carries a "bpm" suffix through StatTile's own `unit` prop,
  // which InsightCard's default formatMetricValue call does not add on its own; formatWithUnit
  // (format.ts) is the shared closure that appends it, the same one Dashboard.tsx, Health.tsx and
  // Weight.tsx's own copies of this card use, rather than a fourth local closure identical but for
  // the metric and the unit key.
  const restingHrInsightFormat = (value: number | null, absent: string): string =>
    formatWithUnit(value, absent, (v) => formatMetricValue(v, 'resting_heart_rate', i18n.language, ''), t('recovery.units.bpm'))

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('recovery.title')}</h1>
      <ControlRow controls={resolved} sources={sources} syncedMinutesAgo={syncedMinutesAgo} exportPath={exportPath} />
      <div className="grid">
        {card('resting_heart_rate', 'recovery.restingHeartRate.label', 'recovery.restingHeartRate.basis',
          'recovery.restingHeartRate.chartLabel', 'recovery.units.beatsPerMinute', 'recovery.units.bpm',
          'lower-is-better', restingHrBaseline, restingHrBand)}
        {card('daily_hrv', 'recovery.dailyHrv.label', 'recovery.dailyHrv.basis',
          'recovery.dailyHrv.chartLabel', 'recovery.units.milliseconds', 'recovery.units.ms',
          'higher-is-better', hrvBaseline, hrvBand)}
        {card('respiratory_rate', 'recovery.respiratoryRate.label', 'recovery.respiratoryRate.basis',
          'recovery.respiratoryRate.chartLabel', 'recovery.units.breathsPerMinute', 'recovery.units.breathsPerMinuteShort',
          'neutral', respiratoryBaseline, respiratoryBand)}

        {/* label is its own catalogue string, not recovery.restingHeartRate.label reused: a
            second card sharing "Resting heart rate" would make a label lookup by exact text
            ambiguous, the same collision Dashboard.tsx's own comment on INSIGHTS explains at more
            length. */}
        <InsightCard insight={restingHrInsight.data} query={restingHrInsight} metric="resting_heart_rate" span={4}
          label={t('recovery.insights.restingHeartRate')} formatValue={restingHrInsightFormat} />
      </div>
      {annotateTarget && <AnnotatePanel target={annotateTarget} onClose={() => setAnnotateTarget(null)} />}
    </>
  )
}
