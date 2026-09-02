import { useMemo, useState } from 'react'
import { METRICS } from '@haelan/core/metrics'
import type { DailyAgg } from '@haelan/core/metrics'
import type { Polarity } from '../format.js'
import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { StatTile } from '../components/StatTile.js'
import { MetricCard } from '../components/MetricCard.js'
import { InsightCard } from '../components/InsightCard.js'
import { ErrorState } from '../components/ErrorState.js'
import { Loading } from '../components/Loading.js'
import { ControlRow } from '../components/ControlRow.js'
import { AnnotatePanel } from '../components/AnnotatePanel.js'
import type { AnnotateTarget } from '../components/AnnotatePanel.js'
import { Sparkline } from '../charts/Sparkline.js'
import { ActivityHeatmap } from '../charts/ActivityHeatmap.js'
import { usePageControls } from '../controls/usePageControls.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { useSession } from '../auth/session.js'
import { denseSeries, useSeries } from '../data/useSeries.js'
import type { SeriesPoint } from '../data/useSeries.js'
import { useInsight } from '../data/useInsight.js'
import { useSyncStatus } from '../data/useSyncStatus.js'
import { useAnnotations } from '../data/useAnnotations.js'
import { overridesByMetric, annotationsFor } from '../data/chartAnnotations.js'
import { useDayAnnotations, annotationsWithDay } from '../data/dayAnnotations.js'
import { useMetricGroups } from '../data/useMetricGroups.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { wornOn, coverageIsWearSignal } from '../data/emptyState.js'
import { distinctSources, exportPathFor } from '../data/pageShell.js'
import { deltaFor, formatMetricValue, formatNumber } from '../format.js'

// Every metric this page draws, checked against packages/core/src/derive/metrics.ts rather than
// taken on faith from the brief that named them: steps, distance, floors, total_calories,
// active_energy and the six active-minute/active-zone-minute sub-dimension metrics are all TOTAL
// (aggs: ['sum']), as is workout_minutes; workout_count is the one metric on this page whose only
// aggregate is `count`.
// Two aggs, two requests, the same REQUESTS/under('agg') shape Dashboard.tsx and Recovery.tsx
// already use, so a pairing the catalogue cannot answer drops out of the wire list rather than
// 500ing every card riding along with it (see under()'s own comment on Dashboard.tsx for why).
//
// floors and total_calories carry the reason Task 1 of this milestone existed: both are written
// only as `provider` rows (Google reconciles them itself; there is no per-source sample underneath
// either for a merge to work from), so both have zero rows under `merged`. This page reaches them
// correctly for the same reason every other card here does and nothing here does specially: it
// never names a source of its own, and usePageControls/resolveSource default to ALL_SOURCES, whose
// sourceParam omits the `source` query parameter entirely. Naming a literal source (merged or
// otherwise) here would ask for rows that were never written, exactly the defect Task 1 closed.
export const REQUESTS = {
  sum: [
    'steps', 'distance', 'floors', 'total_calories', 'active_energy',
    'active_minutes_light', 'active_minutes_moderate', 'active_minutes_vigorous',
    'active_zone_minutes_fat_burn', 'active_zone_minutes_cardio', 'active_zone_minutes_peak',
    'workout_minutes',
  ],
  count: ['workout_count'],
} as const satisfies Partial<Record<DailyAgg, readonly string[]>>

function under(agg: keyof typeof REQUESTS): string[] {
  return REQUESTS[agg].filter((metric) => METRICS[metric]?.aggs.includes(agg) ?? false)
}

const SUM_METRICS = under('sum')
const COUNT_METRICS = under('count')

const GROUPS: readonly MetricGroup[] = [
  { agg: 'sum', metrics: SUM_METRICS, covers: REQUESTS.sum },
  { agg: 'count', metrics: COUNT_METRICS, covers: REQUESTS.count },
]

const values = (points: SeriesPoint[]): number[] =>
  points.map((p) => p.value).filter((v): v is number => v !== null)

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

// Every calendar date from `from` to `to`, inclusive. /series drops a day entirely rather than
// sending a null row for it, so the heatmap, which plots by array position, needs this to rebuild
// the full calendar and place an absence dot where a source is silent rather than quietly shrink
// its own grid to only the days that reported. Byte identical to Dashboard.tsx's own copy, which
// this replaces there: the heatmap card moves here in this task and brings its denominator with it.
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let cursor = Date.parse(`${from}T00:00:00Z`); cursor <= end; cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10))
  }
  return dates
}

export function Activity() {
  const { t, i18n } = useTranslation()
  const session = useSession()
  const controls = usePageControls()
  const period = `${controls.from} ${t('common.to')} ${controls.to}`

  // Pinned to the all sources sentinel for the same reason as every sibling page: a per source
  // rollup carries no sourceMix (only a merged row does), so reading the selector's own options off
  // a request scoped to whatever the reader picked would go empty the moment a device filter became
  // active and silently strand them on it.
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

  // The one insight card the brief's own table gives this page: steps at the sum agg the heatmap
  // above already requests (REQUESTS.sum). /insights is its own, unbatched request, unlike
  // /series, so this is one call added on top of the two agg groups above, not multiplied against
  // any card on the page.
  const stepsInsight = useInsight('steps', 'sum', { from: controls.from, to: controls.to }, source)

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
    for (const metric of [...SUM_METRICS, ...COUNT_METRICS]) {
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
    // sumSeries and the count query are what pointsOf actually reads for these metrics; metricGroups
    // itself is rebuilt every render and is not worth tracking.
  }, [rangeDates, sumSeries.data, metricGroups.queryForAgg('count').data])


  // Daily steps heatmap, moved here from Dashboard.tsx rather than copied: same dense-by-date
  // treatment (a day nothing reported still gets a calendar cell, drawn as an absence dot, instead
  // of silently compressing the grid), same dense denominator (every calendar day in range, not
  // just the days that reported), and the same reason it stays outside MetricCard confirmed twice
  // over Task 5's own review: it draws its own absence dot per day instead of a full-card empty
  // state, which MetricCard's emptyStateFor gate would add on top of a chart that has always drawn.
  const stepsPoints = metricGroups.pointsOf('steps')
  const heatmapDays = useMemo(() => {
    const stepsByDate = new Map(stepsPoints.map((p) => [p.localDate, p]))
    return rangeDates.map((date) => {
      const point = stepsByDate.get(date)
      return {
        date, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null,
        steps: point?.value ?? null,
        worn: point !== undefined && (wornOn('steps', point) ?? true),
      }
    })
  }, [rangeDates, stepsPoints])
  const maxSteps = Math.max(0, ...values(stepsPoints))
  // Nothing is stated while the request is in flight: heatmapDays is dense from the moment the page
  // mounts, so counting it before anything has settled would read "0 of 31 days", a specific false
  // claim rather than a vacuous one.
  const stepsQuery = metricGroups.queryFor('steps')
  const stepsOverrides = annotationsFor(overridesByMetricMap, 'steps')
  const stepsAnnotations = annotationsWithDay(dayAnnotationsByMetric, dayAnnotations, 'steps')

  // The same split MetricCard makes for every other card on this page, made by hand because this
  // card draws an absence dot per day rather than a full-card empty state and so stays outside it.
  // Getting it wrong here is what the old wording did: it counted only wornOn === true against
  // every calendar day in range and called the difference "not worn", while the chart's own
  // accessible table read "no reading" for those same days on the stated grounds that absence names
  // no cause (ActivityHeatmap.tsx). Reported against total is the claim the data supports; the wear
  // count is a separate clause over the days that actually answered the question.
  const stepsBasis = (): string | undefined => {
    if (stepsQuery.isError || stepsQuery.isPending) return undefined
    // A settled but empty period is neither pending nor errored, so without this it rendered
    // "0 of 31 days, 0 to 0 steps": a count of nothing, plus a colour domain claimed from no
    // readings at all.
    if (stepsPoints.length === 0) return t('activity.dailySteps.basisNoData', { total: rangeDates.length })
    const answers = stepsPoints.map((point) => wornOn('steps', point))
    const stated = {
      reported: stepsPoints.length, total: rangeDates.length,
      maxSteps: formatMetricValue(maxSteps, 'steps', i18n.language, ''),
    }
    return coverageIsWearSignal('steps')
      ? t('activity.dailySteps.basisWorn', { ...stated, count: answers.filter((w) => w === false).length })
      : t('activity.dailySteps.basis', stated)
  }

  // Every sparkline tile on this page shares one shape: a metric, a sum over the period, and a
  // basis line stating how many of the range's calendar days answered. Parameterised on
  // basisWornKey rather than always deriving it from basisKey, the same choice Recovery.tsx's own
  // card() makes, because MetricCard picks between the two by the metric's own coverage signal
  // (coverageIsWearSignal) and not every metric here carries one: steps, distance and
  // active_energy are continuously sampled (packages/core/src/api/catalogue.ts tier 'intraday')
  // and do, while floors and total_calories are daily-tier provider rollups and do not, and the
  // six sub-dimension metrics and the two workout metrics reach false the same way (see
  // coverageSignal.ts's own comment). A metric with no wear signal never reaches basisWornKey, so passing it the same
  // string as basisKey (rather than inventing an unreachable second template) is what
  // Dashboard.tsx's sleep schedule card already does for the same reason.
  const card = (
    metric: string, span: number, labelKey: string, basisKey: string, basisWornKey: string,
    chartLabelKey: string, unitKey: string, shortUnitKey: string | undefined, polarity: Polarity,
    // Defaults to the catalogue's own precision for `metric`, read through formatMetricValue, so
    // an ordinary TOTAL card (steps, floors, workouts, ...) needs no format argument of its own
    // and cannot drift from METRICS[metric].precision the way this page's old per-card groupNumber
    // calls could. Only distance overrides this: it converts millimeters to kilometers before
    // display, and formatMetricValue must never see a value already converted out of the
    // catalogue's stored unit (format.ts's own comment on formatNumber says why), so that one call
    // site hands in its own formatter instead of taking the default.
    format: (total: number) => string = (total) => formatMetricValue(total, metric, i18n.language, ''),
    // The Sparkline's own accessible table cell, separately from `format` above: `format` runs once
    // on the period's own total, `sparkFormat` runs once per day on `spark.values`, which stay in
    // the metric's stored unit regardless of what `format` displays (Sparkline's own `metric` prop
    // comment explains why the chart itself never converts). Undefined for every card but distance,
    // which otherwise repeats the exact defect an M3e review caught: a table cell reading raw
    // millimeters beside a "Distance in kilometers" column header, while the headline above it
    // already converted. Sparkline falls back to formatMetricValue(v, metric, ...) when this is
    // omitted, the same default `format` above takes.
    sparkFormat?: (value: number | null, absent: string) => string,
  ) => {
    const points = metricGroups.pointsOf(metric)
    const total = sum(values(points))
    const spark = sparklines.get(metric)!
    const { excluded } = annotationsFor(overridesByMetricMap, metric)
    const annotations = annotationsWithDay(dayAnnotationsByMetric, dayAnnotations, metric)
    return (
      <MetricCard metric={metric} span={span} basisPlacement="body" query={metricGroups.queryFor(metric)} points={points}
        basisKey={basisKey} basisWornKey={basisWornKey} basisValues={{ total: rangeDates.length }}>
        {(basis) => (
          <StatTile label={t(labelKey)} value={format(total)} unit={shortUnitKey && t(shortUnitKey)}
            basis={basis} delta={deltaFor(t, metric, values(points), polarity)}>
            <Sparkline values={spark.values} labels={spark.labels} metric={metric} formatValue={sparkFormat}
              label={t(chartLabelKey, { period })} unit={t(unitKey)}
              annotations={annotations} excluded={excluded}
              onPointClick={(localDate) => setAnnotateTarget({ localDate, metric })} />
          </StatTile>
        )}
      </MetricCard>
    )
  }

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('activity.title')}</h1>
      <ControlRow controls={resolved} sources={sources} syncedMinutesAgo={syncedMinutesAgo} exportPath={exportPath} />
      <div className="grid">
        <Card span={12} label={t('activity.dailySteps.label')} basis={stepsBasis()}>
          {stepsQuery.isError ? <ErrorState onRetry={() => void stepsQuery.refetch()} />
            : stepsQuery.isPending ? <Loading /> : (
            <ActivityHeatmap days={heatmapDays} max={maxSteps} label={t('activity.dailySteps.chartLabel', { period })}
              annotations={stepsAnnotations} excluded={stepsOverrides.excluded}
              onPointClick={(localDate) => setAnnotateTarget({ localDate, metric: 'steps' })} />
          )}
        </Card>

        {card('distance', 4, 'activity.distance.label', 'activity.distance.basis', 'activity.distance.basisWorn',
          'activity.distance.chartLabel', 'activity.units.distance', 'activity.units.km', 'higher-is-better',
          // distance is stored in millimeters (METRICS.distance, precision 0); this card displays
          // the period's total as kilometers with one decimal, a precision the catalogue's own
          // field describes a different unit than, so it cannot answer this card's question (the
          // audit's own finding #9). Converted here and handed to formatNumber directly with its
          // own precision, never to formatMetricValue, which would apply millimeters' precision 0
          // to a kilometers value and print "5" instead of "5.2" (see formatNumber's own comment
          // in format.ts for why formatMetricValue has no parameter that could do this by accident).
          (total) => formatNumber(total / 1_000_000, 1, i18n.language, ''),
          // The Sparkline's own accessible table cell, same conversion applied per day rather than
          // to the period total: without this, the table sat behind formatMetricValue's default
          // (metric 'distance', catalogue precision 0, millimeters) and printed the raw per-day
          // millimeter reading ("5,234,567") under a column header reading "Distance in
          // kilometers" -- correct for precision, wrong for unit, and exactly what an M3e review
          // caught. `v === null` first: a day with no reading stays a day with no reading, not
          // `null / 1_000_000` becoming 0 and reading as a real zero-kilometer day.
          (v, absent) => formatNumber(v === null ? null : v / 1_000_000, 1, i18n.language, absent))}
        {card('floors', 4, 'activity.floors.label', 'activity.floors.basis', 'activity.floors.basis',
          'activity.floors.chartLabel', 'activity.units.floors', 'activity.units.floorsShort', 'higher-is-better')}
        {card('total_calories', 4, 'activity.totalCalories.label', 'activity.totalCalories.basis', 'activity.totalCalories.basis',
          'activity.totalCalories.chartLabel', 'activity.units.kcal', 'activity.units.kcalShort', 'higher-is-better')}
        {card('active_energy', 4, 'activity.activeEnergy.label', 'activity.activeEnergy.basis', 'activity.activeEnergy.basisWorn',
          'activity.activeEnergy.chartLabel', 'activity.units.kcal', 'activity.units.kcalShort', 'higher-is-better')}

        {card('active_minutes_light', 4, 'activity.activeMinutesLight.label', 'activity.activeMinutesLight.basis', 'activity.activeMinutesLight.basis',
          'activity.activeMinutesLight.chartLabel', 'activity.units.minutes', 'activity.units.min', 'higher-is-better')}
        {card('active_minutes_moderate', 4, 'activity.activeMinutesModerate.label', 'activity.activeMinutesModerate.basis', 'activity.activeMinutesModerate.basis',
          'activity.activeMinutesModerate.chartLabel', 'activity.units.minutes', 'activity.units.min', 'higher-is-better')}
        {card('active_minutes_vigorous', 4, 'activity.activeMinutesVigorous.label', 'activity.activeMinutesVigorous.basis', 'activity.activeMinutesVigorous.basis',
          'activity.activeMinutesVigorous.chartLabel', 'activity.units.minutes', 'activity.units.min', 'higher-is-better')}

        {card('active_zone_minutes_fat_burn', 4, 'activity.activeZoneMinutesFatBurn.label', 'activity.activeZoneMinutesFatBurn.basis', 'activity.activeZoneMinutesFatBurn.basis',
          'activity.activeZoneMinutesFatBurn.chartLabel', 'activity.units.minutes', 'activity.units.min', 'higher-is-better')}
        {card('active_zone_minutes_cardio', 4, 'activity.activeZoneMinutesCardio.label', 'activity.activeZoneMinutesCardio.basis', 'activity.activeZoneMinutesCardio.basis',
          'activity.activeZoneMinutesCardio.chartLabel', 'activity.units.minutes', 'activity.units.min', 'higher-is-better')}
        {card('active_zone_minutes_peak', 4, 'activity.activeZoneMinutesPeak.label', 'activity.activeZoneMinutesPeak.basis', 'activity.activeZoneMinutesPeak.basis',
          'activity.activeZoneMinutesPeak.chartLabel', 'activity.units.minutes', 'activity.units.min', 'higher-is-better')}

        {card('workout_count', 4, 'activity.workoutCount.label', 'activity.workoutCount.basis', 'activity.workoutCount.basis',
          'activity.workoutCount.chartLabel', 'activity.units.workouts', 'activity.units.workoutsShort', 'neutral')}
        {card('workout_minutes', 4, 'activity.workoutMinutes.label', 'activity.workoutMinutes.basis', 'activity.workoutMinutes.basis',
          'activity.workoutMinutes.chartLabel', 'activity.units.minutes', 'activity.units.min', 'neutral')}

        {/* label is its own catalogue string, not activity.dailySteps.label reused: a second card
            sharing "Daily steps" would make a label lookup by exact text ambiguous, the same
            collision Dashboard.tsx's own comment on INSIGHTS explains at more length. No
            formatValue: the heatmap's own basis line already prints a plain, unitless steps total
            through formatMetricValue, which is exactly what InsightCard's own default does without
            one. */}
        <InsightCard insight={stepsInsight.data} query={stepsInsight} metric="steps" span={4}
          label={t('activity.insights.steps')} />
      </div>
      {annotateTarget && <AnnotatePanel target={annotateTarget} onClose={() => setAnnotateTarget(null)} />}
    </>
  )
}
