import { useMemo, useState } from 'react'
import { METRICS } from '@haelan/core/metrics'
import type { DailyAgg } from '@haelan/core/metrics'
import { useTranslation } from '../i18n/index.js'
import { StatTile } from '../components/StatTile.js'
import { MetricCard } from '../components/MetricCard.js'
import { ChartNote } from '../components/ChartNote.js'
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
import { useTrend } from '../data/useTrend.js'
import { useBaseline } from '../data/useBaseline.js'
import type { Baseline } from '../data/useBaseline.js'
import { useInsight } from '../data/useInsight.js'
import { useSyncStatus } from '../data/useSyncStatus.js'
import { useAnnotations } from '../data/useAnnotations.js'
import { overridesByMetric, annotationsFor } from '../data/chartAnnotations.js'
import { useDayAnnotations, annotationsWithDay } from '../data/dayAnnotations.js'
import { useMetricGroups } from '../data/useMetricGroups.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { distinctSources, sourcesStoppedInRange, exportPathFor } from '../data/pageShell.js'
import { deltaFor, formatMetricValue, formatNumber, formatWithUnit } from '../format.js'

// weight and body_fat both carry `aggs: ['last', 'mean']` in packages/core/src/derive/metrics.ts;
// this page only ever asks for 'last', the same REQUESTS/under('agg') shape every sibling page
// uses so a pairing the catalogue cannot answer drops off the wire rather than 500ing the group
// (see under()'s own comment on Dashboard.tsx for why).
export const REQUESTS = {
  last: ['weight', 'body_fat'],
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
  // Thin stays undefined, not a band drawn thin: a band computed from a handful of readings looks
  // exactly as authoritative as one computed from sixty days, and thin is the reader's only signal
  // that it is not. Same reasoning as Recovery.tsx's own bandFrom, page owned rather than shared
  // for the same reason that file's own comment on datesBetween states. In grams, the stored unit,
  // the same unit weightTrend and spark.values already stay in below: a chart's y axis is a linear
  // rescale of whatever unit it is handed, so the band never needs the kilogram conversion the
  // headline and the insight card apply for display.
  return baseline !== null && !baseline.thin
    ? { low: baseline.center - baseline.spread, high: baseline.center + baseline.spread }
    : undefined
}

export function Weight() {
  const { t, i18n } = useTranslation()
  const session = useSession()
  const controls = usePageControls()
  const period = `${controls.from} ${t('common.to')} ${controls.to}`

  // Same reasoning as every sibling page's own sourceEnumeration: pinned to the all sources
  // sentinel so picking a real device does not blank the selector that offers switching back.
  const sourceEnumeration = useSeries([...LAST_METRICS], { from: controls.from, to: controls.to, source: ALL_SOURCES }, 'last')
  const sources = distinctSources([sourceEnumeration])
  // Off the same all-sources enumeration the selector is built from, so this costs no
  // request of its own: the mix is already on the points that query returned.
  const stoppedSources = sourcesStoppedInRange([sourceEnumeration], controls.to)
  const source = resolveSource(controls.source, [ALL_SOURCES, ...sources])
  const range = { from: controls.from, to: controls.to, source }
  const resolved = { ...controls, source }

  // The day and metric a chart's own click named, or null when no panel is open. Same single slot
  // every other page's copy of this state uses, and the same reason: only one panel is ever open.
  const [annotateTarget, setAnnotateTarget] = useState<AnnotateTarget | null>(null)
  const overridesQuery = useAnnotations(range)
  const overridesByMetricMap = useMemo(
    () => overridesByMetric(overridesQuery.overrides.data?.items ?? []),
    [overridesQuery.overrides.data],
  )
  const { dayAnnotations, dayAnnotationsByMetric } =
    useDayAnnotations(overridesQuery.notes, overridesQuery.events, overridesByMetricMap)

  const metricGroups = useMetricGroups(GROUPS, range)
  const lastSeries = metricGroups.queryForAgg('last')

  const syncStatus = useSyncStatus()
  const syncedMinutesAgo = syncStatus.data?.lastFinishedAtMs != null
    ? Math.max(0, Math.round((Date.now() - syncStatus.data.lastFinishedAtMs) / 60_000))
    : null
  const personId = session.data?.personId
  const exportPath = personId !== undefined ? exportPathFor(personId, LAST_METRICS, 'last', range) : undefined

  // Every calendar day in the range, the axis the sparklines below are built along. Not a basis
  // line denominator here the way it is on every sibling page: weight and body_fat are episodic
  // (see card()'s own comment below), and "{{reported}} of {{total}} days" would count every
  // unweighed day as a shortfall against a metric nobody expects a row from daily, the same
  // framing the chart itself stopped drawing when M3e-1 dropped its absence marks.
  const rangeDates = useMemo(() => datesBetween(controls.from, controls.to), [controls.from, controls.to])

  // Stable array identities for the reason every sibling page's own copy of this memo states:
  // useChart keys its rebuild on `build`, itself a useCallback over `values`, so a freshly
  // constructed array on every render disposes and reinitialises the chart.
  const sparklines = useMemo(() => {
    const out = new Map<string, { values: (number | null)[], labels: string[] }>()
    for (const metric of LAST_METRICS) {
      const points = metricGroups.pointsOf(metric)
      out.set(metric, denseSeries(rangeDates, points))
    }
    return out
  }, [rangeDates, lastSeries.data])

  // PersonQuery.trend was specced and built for this card and M3e-1 drew the raw readings above
  // instead, without a consumer for it. `source`, not `controls.source`: the same resolveSource
  // correction `range` above reads through, so a link naming a source this person does not have
  // (or one removed since the link was made) cannot query the trend line under it either.
  const weightTrendQuery = useTrend({ metric: 'weight', agg: 'last', from: controls.from, to: controls.to, source })
  // Dense over the same rangeDates axis the readings sparkline above is built along, so Sparkline
  // can zip trend and values by position (Sparkline's own `trend` prop comment says why): the route
  // answers only the days trendOf actually smoothed, sparse exactly like a /series response, and a
  // caller reading it straight would be zipping a sparse array against a dense one by index rather
  // than by date, the same defect denseSeries above exists to rule out for the readings.
  const weightTrend = useMemo(() => {
    const byDate = new Map((weightTrendQuery.data?.points ?? []).map((p) => [p.localDate, p.value]))
    return rangeDates.map((date) => byDate.get(date) ?? null)
  }, [rangeDates, weightTrendQuery.data])

  // weight's own baseline band, not body_fat's: this is the card the audit named ("Weight's
  // trend"), and body_fat carries no trend line either (see card()'s own `trend` parameter
  // comment for why that stays undefined for it too). 'last' explicitly, the same reason
  // Recovery.tsx passes it rather than the default: weight's catalogue entry pairs `aggs: ['last',
  // 'mean']`, and this page only ever asks for 'last' (REQUESTS above). historicalTo, not
  // controls.to: see Dashboard.tsx's own hrBaseline comment for why a Month or Year view's
  // calendar end is not the same date as the last day that has actually happened.
  const weightBaseline = useBaseline('weight', controls.historicalTo, source, 'last')
  const weightBand = useMemo(() => bandFrom(weightBaseline.data?.baseline ?? null), [weightBaseline.data])

  // The one insight card the brief's own table gives this page: weight at the last agg both
  // cards above already request (REQUESTS.last). /insights is its own, unbatched request, so this
  // is one call added on top of the single group above. Suppresses often, correctly: 130 readings
  // across 236 days in the household this page was built against means a seven day window
  // frequently holds too few, and InsightCard's own suppressed branch is what that renders as, not
  // a bug this card routes around. `to` is historicalTo, not controls.to: see Dashboard.tsx's own
  // insightRange comment for why a period whose calendar end has not happened yet must not be
  // counted into periodDays.
  const weightInsight = useInsight('weight', 'last', { from: controls.from, to: controls.historicalTo }, source)
  // The trap this whole page exists to get right, restated for the insight card: METRICS.weight
  // declares precision 1 in grams, the stored unit, and the headline above converts to kilograms
  // through formatNumber directly rather than formatMetricValue (see card()'s own comment and
  // format.ts's own comment on formatNumber for why a converted value can never reach it).
  // formatWithUnit (format.ts) supplies the "kg" suffix the headline carries through StatTile's
  // own `unit` prop, which InsightCard's default has no way to add on its own, the same shared
  // closure Dashboard.tsx, Recovery.tsx and Health.tsx's own copies of this card use; only the
  // `format` callback here differs from theirs, since this is the one call site that converts a
  // unit rather than reading the catalogue's stored one.
  const weightInsightFormat = (value: number | null, absent: string): string =>
    formatWithUnit(value, absent, (v) => formatNumber(v / 1000, 1, i18n.language, ''), t('weight.units.kg'))

  // The same trap, one level deeper: InsightCard's default delta is `insight.delta`, which
  // apps/server/src/routes/v1/series.ts derives from `current` and `previous` after rounding both
  // to precision 1 in GRAMS, the stored unit. Dividing that gram delta by 1000 and rounding again
  // to kilograms crosses a rounding boundary the two already-converted kilogram figures above do
  // not, the identical failure the route's own comment on `delta` exists to rule out one level up
  // (a real case: 81234.5 g and 81469.0 g display as 81.2 kg and 81.5 kg, a difference of -0.3, while
  // the stored delta of -234.5 g divides to -0.2 kg). Rounding `current` and `previous` to
  // kilograms first, the same way the route rounds them to grams, and subtracting those two rounded
  // kilogram figures instead reproduces the route's own guarantee at the unit this card actually
  // shows, so the three numbers a reader sees always agree again.
  const weightInsightFormatDelta = (current: number, previous: number): string => {
    const toKg = (grams: number): number => Number((grams / 1000).toFixed(1))
    const delta = Number((toKg(current) - toKg(previous)).toFixed(1))
    return formatWithUnit(delta, '', (v) => formatNumber(v, 1, i18n.language, ''), t('weight.units.kg'))
  }

  // Both cards on this page are `episodic`: a weight (or a body fat reading) is taken by hand, not
  // sampled continuously, so a day nobody weighed in is not a data quality problem the way a gap
  // in a wearable's own record would be (see Sparkline's own `episodic` prop comment for the full
  // reasoning, which lives there once rather than being restated here).
  //
  // basisWornKey is handed the same string as basisKey, not a distinct wear-clause template:
  // neither metric carries a tier override in packages/core/src/api/catalogue.ts, so both default
  // to 'daily' rather than 'intraday' and coverageIsWearSignal reads neither as a wear signal.
  // MetricCard's wear branch can therefore never fire for either, the same choice Recovery.tsx's
  // own card() and Dashboard.tsx's sleep schedule card already make for the identical reason.
  const card = (
    metric: string, labelKey: string, basisKey: string, readingsKey: string, chartLabelKey: string,
    unitKey: string, shortUnitKey: string,
    // Defaults to the catalogue's own precision for `metric`, read through formatMetricValue: the
    // right path for body_fat, which is a percent and needs no conversion. weight is the one call
    // site that overrides this, the same shape Activity.tsx's distance card takes for the same
    // reason (format.ts's own comment on formatNumber says why a converted value can never go
    // through formatMetricValue).
    format: (value: number) => string = (value) => formatMetricValue(value, metric, i18n.language, ''),
    // Sparkline's own accessible table cell, separate from `format` above: `format` runs once on
    // the period's own headline, `sparkFormat` runs once per day on `spark.values`, which stay in
    // grams regardless of what `format` displays (Sparkline's own `formatValue` prop comment says
    // why the chart itself never converts). Undefined for body_fat, which falls back to
    // Sparkline's own default (`formatMetricValue(v, metric, ...)`).
    sparkFormat?: (value: number | null, absent: string) => string,
    // Undefined for body_fat, the same as `sparkFormat` above: PersonQuery.trend was specced and
    // built against the weight metric this card requests (weightTrendQuery above), and no sibling
    // card on this page has a trend line to draw.
    trend?: (number | null)[],
    // Undefined for body_fat, the same as `trend` above: weightBand (above) is the one baseline
    // this page requests, over the one metric the audit named ("Weight's trend").
    band?: { low: number, high: number },
  ) => {
    const points = metricGroups.pointsOf(metric)
    const headline = mean(values(points))
    const spark = sparklines.get(metric)!
    const { excluded } = annotationsFor(overridesByMetricMap, metric)
    const annotations = annotationsWithDay(dayAnnotationsByMetric, dayAnnotations, metric)
    // D10: pre-resolved before MetricCard, the same reason Health.tsx's own spo2Readings is
    // (that file's own comment on the idiom says why in full). MetricCard's plain-key branch
    // interpolates `reported`, not `count`, so a template counting the reading itself has to
    // arrive already pluralised rather than lean on i18next's own count-based suffix picking,
    // which only fires for an option literally named `count`. This is also D10's actual fix, not
    // only its plumbing: the basis line used to read "mean, {{reported}} of {{total}} days",
    // which stated every unweighed calendar day as a shortfall against a metric taken by hand
    // (weight and body_fat are both `episodic`, see below), the exact framing M3e-1 already
    // dropped from this same chart's absence marks. Counting only the readings that exist, not
    // the calendar days that don't carry one, is what makes the basis line agree with the chart
    // beside it again.
    const readings = t(readingsKey, { count: points.length })
    return (
      <MetricCard metric={metric} span={6} basisPlacement="body" query={metricGroups.queryFor(metric)} points={points}
        oneDayRange={controls.tab === 'day'}
        basisKey={basisKey} basisWornKey={basisKey} basisValues={{ readings }}>
        {(basis, oneDayRange) => (
          <StatTile label={t(labelKey)} value={format(headline)} unit={t(shortUnitKey)}
            basis={basis} delta={deltaFor(t, metric, values(points), 'neutral')}>
            {oneDayRange ? <ChartNote /> : (
              <Sparkline values={spark.values} labels={spark.labels} metric={metric} formatValue={sparkFormat} episodic
                label={t(chartLabelKey, { period })} unit={t(unitKey)} trend={trend} baseline={band}
                annotations={annotations} excluded={excluded}
                onPointClick={(localDate) => setAnnotateTarget({ scope: 'day_metric', localDate, metric })} />
            )}
          </StatTile>
        )}
      </MetricCard>
    )
  }

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('weight.title')}</h1>
      <ControlRow controls={resolved} sources={sources} syncedMinutesAgo={syncedMinutesAgo} exportPath={exportPath}
        stoppedSources={stoppedSources} />
      <div className="grid">
        {card('weight', 'weight.weight.label', 'weight.weight.basis', 'weight.weight.readings',
          'weight.weight.chartLabel', 'weight.units.kilograms', 'weight.units.kg',
          // weight is stored in grams with precision 1 (METRICS.weight, declared in grams, the
          // stored unit); this card displays kilograms, a precision the catalogue's own field
          // cannot answer for a converted unit (the trap this page exists to get right, and the
          // exact defect an M3e review caught on Activity's distance card). Converted here and
          // handed to formatNumber directly with its own precision, never to formatMetricValue,
          // which would apply grams' precision to a kilograms value.
          (headline) => formatNumber(headline / 1000, 1, i18n.language, ''),
          // Same conversion applied per day to the chart's own accessible table: the chart's y
          // axis is hidden and a linear rescale draws an identical shape regardless of unit, so
          // `spark.values` stays in grams (Sparkline's own `metric` prop comment says why) and
          // only this formatter converts. `v === null` first, and it is load-bearing even though
          // episodic drops a genuinely silent day before this ever runs: an excluded day still
          // reaches it (deriveDay deletes the excluded metric's own row) and so does an unweighed
          // day carrying a day-level note or event (those reach every chart on the page regardless
          // of metric, dayAnnotations.ts's own comment). Without the guard, `null / 1000` coerces
          // to 0 and prints a real "0.0" on either of those rows instead of the absence word
          // ("excluded" or "no reading") the row is meant to carry.
          (v, absent) => formatNumber(v === null ? null : v / 1000, 1, i18n.language, absent),
          weightTrend, weightBand)}
        {card('body_fat', 'weight.bodyFat.label', 'weight.bodyFat.basis', 'weight.bodyFat.readings',
          'weight.bodyFat.chartLabel', 'weight.units.percent', 'weight.units.percentShort')}

        {/* label is its own catalogue string, not weight.weight.label reused: a second card
            sharing "Weight" would make a label lookup by exact text ambiguous, the same collision
            Dashboard.tsx's own comment on INSIGHTS explains at more length. */}
        <InsightCard insight={weightInsight.data} query={weightInsight} metric="weight" span={6}
          label={t('weight.insights.weight')} formatValue={weightInsightFormat} formatDelta={weightInsightFormatDelta} />
      </div>
      {annotateTarget && <AnnotatePanel target={annotateTarget} onClose={() => setAnnotateTarget(null)} />}
    </>
  )
}
