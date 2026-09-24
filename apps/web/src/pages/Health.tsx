import { useMemo, useState } from 'react'
import { METRICS } from '@haelan/core/metrics'
import type { DailyAgg } from '@haelan/core/metrics'
import { useTranslation } from '../i18n/index.js'
import { CardGrid } from '../components/CardGrid.js'
import { StatTile } from '../components/StatTile.js'
import { MetricCard } from '../components/MetricCard.js'
import { ChartNote } from '../components/ChartNote.js'
import { InsightCard } from '../components/InsightCard.js'
import { ControlRow } from '../components/ControlRow.js'
import { AnnotatePanel } from '../components/AnnotatePanel.js'
import type { AnnotateTarget } from '../components/AnnotatePanel.js'
import { Sparkline } from '../charts/Sparkline.js'
import { Spo2Range } from '../charts/Spo2Range.js'
import type { Spo2Day } from '../charts/Spo2Range.js'
import { usePageControls } from '../controls/usePageControls.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { useSession } from '../auth/session.js'
import { denseSeries, useSeries } from '../data/useSeries.js'
import type { SeriesPoint } from '../data/useSeries.js'
import { useBaseline } from '../data/useBaseline.js'
import type { Baseline } from '../data/useBaseline.js'
import { useInsight } from '../data/useInsight.js'
import { useAnnotations } from '../data/useAnnotations.js'
import { overridesByMetric, annotationsFor, filledAnnotationsFrom } from '../data/chartAnnotations.js'
import { useDayAnnotations, annotationsWithDay } from '../data/dayAnnotations.js'
import { useMetricGroups } from '../data/useMetricGroups.js'
import { useLastYear } from '../data/lastYear.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { distinctSources, exportPathFor } from '../data/pageShell.js'
import { deltaFor, formatMetricValue, formatWithUnit } from '../format.js'

// Two cards is a slight page, and the reason is not that there is little here worth measuring:
// electrocardiogram, core-body-temperature, blood-glucose and irregular-rhythm-notification are
// data types the Google Health API already offers and this project already fetches and archives
// (see M4/M5's own catalogue drift note), but none of the four has a `listable(...)` entry in
// packages/core/src/api/catalogue.ts yet, so there is no metric id, no derived row and nothing
// this page could request for any of them today. This page grows the day ingestion catches up to
// what the API already sends, not because a wider read of "health" was left undone here.
//
// daily_spo2, not spo2, for the once a day summary: spo2 is the intraday series (aggs: ['min',
// 'mean', 'max', 'count']) the range chart below draws, and daily_spo2 is the once a day reading
// (aggs: ['last']) the API sends already averaged. Same distinction Recovery.tsx's own top comment
// draws between daily_hrv and hrv, and REQUESTS/under is the same pair for the same reason: which
// agg a card shows is this page's decision, and `under` is where that decision is checked against
// the catalogue rather than assumed.
export const REQUESTS = {
  last: ['daily_spo2'],
} as const satisfies Partial<Record<DailyAgg, readonly string[]>>

function under(agg: keyof typeof REQUESTS): string[] {
  return REQUESTS[agg].filter((metric) => METRICS[metric]?.aggs.includes(agg) ?? false)
}

const LAST_METRICS = under('last')

const GROUPS: readonly MetricGroup[] = [
  { agg: 'last', metrics: LAST_METRICS, covers: REQUESTS.last },
]

// One shared empty array for every fallback below, the same device useMetricGroups.ts's own EMPTY
// is and for the same reason: a fresh `[]` on every render gives the range chart's `build`
// callback a new array identity, and useChart reads that as "the data changed," disposing and
// re-initialising the chart on a render that changed nothing.
const EMPTY = Object.freeze([]) as never[]

const values = (points: SeriesPoint[]): number[] =>
  points.map((p) => p.value).filter((v): v is number => v !== null)

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
  // Thin stays undefined, not a band drawn thin: a band computed from a handful of days looks
  // exactly as authoritative as one computed from sixty, and thin is the reader's only signal
  // that it is not. Same reasoning as Recovery.tsx's own bandFrom, page owned rather than shared
  // for the same reason that file's own comment on datesBetween states.
  return baseline !== null && !baseline.thin
    ? { low: baseline.center - baseline.spread, high: baseline.center + baseline.spread }
    : undefined
}

export function Health() {
  const { t, i18n } = useTranslation()
  const session = useSession()
  const controls = usePageControls()
  const period = `${controls.from} ${t('common.to')} ${controls.to}`

  // Same reasoning as Recovery.tsx's own sourceEnumeration: pinned to the all sources sentinel so
  // picking a real device does not blank the selector that offers switching back.
  const sourceEnumeration = useSeries([...LAST_METRICS], { from: controls.from, to: controls.to, source: ALL_SOURCES }, 'last')
  const sources = distinctSources([sourceEnumeration])
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

  // spo2's own four series, kept out of `GROUPS` above rather than folded in as four more entries:
  // min, mean, max and count all share the one name 'spo2', and useMetricGroups resolves a metric
  // to a group by name alone, so a metric riding in more than one group would always resolve to
  // whichever group happened to come first (see useMetricGroups.ts's own comment on why). Same
  // shape Dashboard.tsx's heart_rate min/max stay their own useSeries calls outside its GROUPS for
  // the identical reason.
  const meanSpo2 = useSeries(['spo2'], range, 'mean')
  const minSpo2 = useSeries(['spo2'], range, 'min')
  const maxSpo2 = useSeries(['spo2'], range, 'max')
  const countSpo2 = useSeries(['spo2'], range, 'count')

  const personId = session.data?.personId
  const exportPath = personId !== undefined ? exportPathFor(personId, LAST_METRICS, 'last', range) : undefined

  // Every calendar day in the range: the axis the range chart's days array and the daily card's
  // sparkline are both built along, and the denominator every basis line below counts against.
  const rangeDates = useMemo(() => datesBetween(controls.from, controls.to), [controls.from, controls.to])
  // The same groups over the same days a year earlier, asked for only while the comparison is on.
  // Ended at historicalTo, not the period's end: a month six days old is set against the same six
  // days a year earlier, never against the whole of last year's month.
  const lastYear = useLastYear(GROUPS, { ...range, to: controls.historicalTo }, rangeDates, controls.compareYear === true)

  const meanSpo2Points = meanSpo2.data?.spo2?.points ?? EMPTY
  const minSpo2Points = minSpo2.data?.spo2?.points ?? EMPTY
  const maxSpo2Points = maxSpo2.data?.spo2?.points ?? EMPTY
  const countSpo2Points = countSpo2.data?.spo2?.points ?? EMPTY

  // One day per date in range, each of the four values looked up by localDate rather than zipped
  // by array position: the four requests can each be silent on a different day, and are not
  // guaranteed to line up index for index. Same reasoning as Dashboard.tsx's own heartRateDays.
  const spo2Days: Spo2Day[] = useMemo(() => {
    const meanByDate = new Map(meanSpo2Points.map((p) => [p.localDate, p.value]))
    const minByDate = new Map(minSpo2Points.map((p) => [p.localDate, p.value]))
    const maxByDate = new Map(maxSpo2Points.map((p) => [p.localDate, p.value]))
    const countByDate = new Map(countSpo2Points.map((p) => [p.localDate, p.value]))
    return rangeDates.map((date) => ({
      date,
      min: minByDate.get(date) ?? null,
      mean: meanByDate.get(date) ?? null,
      max: maxByDate.get(date) ?? null,
      count: countByDate.get(date) ?? null,
    }))
  }, [rangeDates, meanSpo2Points, minSpo2Points, maxSpo2Points, countSpo2Points])

  // All four requests, not only the mean: a card drawing four series has not settled until the
  // last of them has, and has failed if any of them did. Same composite shape Dashboard.tsx builds
  // for its own heart rate range card, for the same reason (MetricCard takes one query, not four).
  const spo2Failed = meanSpo2.isError || minSpo2.isError || maxSpo2.isError || countSpo2.isError
  // Whichever of the four actually failed - see Dashboard.tsx's identical heartRateError comment.
  const spo2Error = meanSpo2.error ?? minSpo2.error ?? maxSpo2.error ?? countSpo2.error
  const spo2Pending = meanSpo2.isPending || minSpo2.isPending || maxSpo2.isPending || countSpo2.isPending
  const retrySpo2 = () => {
    void meanSpo2.refetch()
    void minSpo2.refetch()
    void maxSpo2.refetch()
    void countSpo2.refetch()
  }

  const spo2Overrides = annotationsFor(overridesByMetricMap, 'spo2')
  const spo2Annotations = annotationsWithDay(dayAnnotationsByMetric, dayAnnotations, 'spo2')

  const dailySpo2Points = metricGroups.pointsOf('daily_spo2')
  const dailySpo2Overrides = annotationsFor(overridesByMetricMap, 'daily_spo2')
  const dailySpo2Annotations = annotationsWithDay(dayAnnotationsByMetric, dayAnnotations, 'daily_spo2')
  // daily_spo2 is the one metric on this page DEVICE_ROLLED_EQUIVALENT (personQuery.ts) can ever
  // mark filled, so the merge is built here rather than as a second, generic helper this page has
  // only one caller for. filledAnnotationsFrom already answers the same shared empty array by
  // identity whenever nothing is filled, so the common case costs no new array either way, and
  // this useMemo only allocates on a render that actually has a filled day to show.
  const dailySpo2FilledAnnotations = useMemo(
    () => filledAnnotationsFrom(dailySpo2Points, t), [dailySpo2Points, t],
  )
  const dailySpo2AnnotationsWithFilled = useMemo(
    () => (dailySpo2FilledAnnotations.length === 0
      ? dailySpo2Annotations
      : [...dailySpo2Annotations, ...dailySpo2FilledAnnotations]),
    [dailySpo2Annotations, dailySpo2FilledAnnotations],
  )
  const dailySpo2Spark = useMemo(
    () => denseSeries(rangeDates, dailySpo2Points), [rangeDates, dailySpo2Points],
  )
  const dailySpo2Headline = mean(values(dailySpo2Points))

  // The daily summary card's own band. Not spo2Range above: that chart draws min/mean/max on one
  // set of category axes with no y position a band could sit behind (Spo2Range's own top comment
  // already states it carries no baseline equivalent to HeartRateRange's), so only daily_spo2, the
  // once a day summary, gets one. 'last' explicitly, the same reason Recovery.tsx passes it rather
  // than the default: daily_spo2's only agg is 'last'. historicalTo, not controls.to: see
  // Dashboard.tsx's own hrBaseline comment for why a Month or Year view's calendar end is not the
  // same date as the last day that has actually happened.
  const dailySpo2Baseline = useBaseline('daily_spo2', controls.historicalTo, source, 'last')
  const dailySpo2Band = useMemo(
    () => bandFrom(dailySpo2Baseline.data?.baseline ?? null), [dailySpo2Baseline.data],
  )

  // The one insight card the brief's own table gives this page: daily_spo2 at the last agg the
  // card above already requests (REQUESTS.last). /insights is its own, unbatched request, so this
  // is one call added on top of the five requests above (LAST_METRICS plus spo2's own four). `to`
  // is historicalTo, not controls.to: see Dashboard.tsx's own insightRange comment for why a
  // period whose calendar end has not happened yet must not be counted into periodDays.
  const dailySpo2Insight = useInsight('daily_spo2', 'last', { from: controls.from, to: controls.historicalTo }, source)
  // The daily summary card above carries a "%" suffix through StatTile's own `unit` prop;
  // formatWithUnit (format.ts) is the shared closure that appends it, the same one Dashboard.tsx,
  // Recovery.tsx and Weight.tsx's own copies of this card use.
  const dailySpo2InsightFormat = (value: number | null, absent: string): string =>
    formatWithUnit(value, absent, (v) => formatMetricValue(v, 'daily_spo2', i18n.language, ''), t('health.units.percentShort'))

  // The milestone's own deliverable ("SpO2 with interval and count", spec section 4): the day's
  // reading count belongs in the basis line, not only in the tooltip and the accessible table it
  // already reached. Summed across the displayed range, the same "total across days" shape
  // Sleep.tsx's own napCountTotal takes for its per-period count.
  //
  // Resolved to its own pluralised phrase here, before it ever reaches MetricCard, rather than
  // handed over as a bare number under the name `count`: MetricCard's wear branch always fires for
  // spo2 (coverageIsWearSignal reads its 'intraday' tier as a wear signal), and that branch
  // unconditionally overwrites a `count` entry in basisValues with its own "days not worn" figure
  // (MetricCard.tsx's own comment says why). i18next pluralises whichever option is actually named
  // `count`, not whichever placeholder token a template happens to embed it under, so a reading
  // count riding in under that name would silently lose to the wear count rather than surviving
  // beside it. `readings` is a plain, already-resolved string by the time basisWorn interpolates
  // it, the same shape `period` already is for chartLabel below.
  const spo2ReadingCount = sum(values(countSpo2Points))
  const spo2Readings = t('health.spo2Range.readings', { count: spo2ReadingCount })

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('health.title')}</h1>
      <ControlRow controls={resolved} sources={sources} exportPath={exportPath} trendNote yearCompare />
      <CardGrid>
        {/* basisPlacement 'header': the range chart carries no StatTile of its own to fold a basis
            into, the same reason Dashboard.tsx's heart rate range card takes 'header' rather than
            'body'. spo2 is an intraday metric (packages/core/src/api/catalogue.ts gives it `tier:
            'intraday'`), so coverageIsWearSignal reads it as a real wear signal and MetricCard
            always resolves to basisWornKey here; basisKey is still spelled out below rather than
            reused for both props, the same completeness Dashboard's own steps tile keeps for a
            plain key its own wear signal never reaches either. */}
        <MetricCard metric="spo2" span={8} label={t('health.spo2Range.label')} basisPlacement="header"
          query={{ isError: spo2Failed, isPending: spo2Pending, refetch: retrySpo2, error: spo2Error }}
          points={meanSpo2Points}
          basisKey="health.spo2Range.basis" basisWornKey="health.spo2Range.basisWorn"
          basisValues={{ total: rangeDates.length, readings: spo2Readings }}
          oneDayRange={controls.tab === 'day'}>
          {/* The whole of `children` is the chart here, the same shape Dashboard's own sleep
              schedule card takes, so the swap happens at the top level rather than inside a
              StatTile. With from === to this card's daily series holds at most one row, and what
              Spo2Range drew for it was a single dot standing in for the "daily minimum, mean and
              maximum" its own label promises across a period. */}
          {(_basis, oneDayRange) => (oneDayRange ? <ChartNote /> : (
            <Spo2Range days={spo2Days} annotations={spo2Annotations} excluded={spo2Overrides.excluded}
              label={t('health.spo2Range.chartLabel', { period })}
              onPointClick={(localDate) => setAnnotateTarget({ scope: 'day_metric', localDate, metric: 'spo2' })} />
          ))}
        </MetricCard>

        {/* basisWornKey is handed the same string as basisKey, not a distinct wear-clause template:
            daily_spo2 carries no tier override (packages/core/src/api/catalogue.ts gives it none,
            so it defaults to 'daily' rather than 'intraday'), so coverageIsWearSignal reads it as
            no wear signal and MetricCard's wear branch can never fire for it. Same choice
            Recovery.tsx's three cards and Dashboard.tsx's sleep schedule card already make for the
            same reason, rather than a second, unreachable literal per metric. */}
        <MetricCard metric="daily_spo2" span={4} basisPlacement="body"
          query={metricGroups.queryFor('daily_spo2')} points={dailySpo2Points}
          basisKey="health.dailySpo2.basis" basisWornKey="health.dailySpo2.basis"
          basisValues={{ total: rangeDates.length }}
          oneDayRange={controls.tab === 'day'}>
          {/* Inside the StatTile, not around it, the same shape every sibling page's own card()
              takes: the value, its delta and the basis line are all still right on a one day
              range, and only the sparkline that would draw a single dot is swapped out. */}
          {(basis, oneDayRange) => (
            <StatTile label={t('health.dailySpo2.label')}
              value={formatMetricValue(dailySpo2Headline, 'daily_spo2', i18n.language, '')}
              unit={t('health.units.percentShort')} basis={basis}
              delta={deltaFor(t, 'daily_spo2', values(dailySpo2Points), 'higher-is-better')}
              lastYear={lastYear.summarise('daily_spo2', (earlier) => formatMetricValue(mean(values(earlier)), 'daily_spo2', i18n.language, ''))}>
              {oneDayRange ? <ChartNote /> : (
                <Sparkline values={dailySpo2Spark.values} labels={dailySpo2Spark.labels} metric="daily_spo2"
                  lastYear={lastYear.alignedOf('daily_spo2')}
                  label={t('health.dailySpo2.chartLabel', { period })} unit={t('health.units.percent')}
                  baseline={dailySpo2Band}
                  annotations={dailySpo2AnnotationsWithFilled} excluded={dailySpo2Overrides.excluded}
                  onPointClick={(localDate) => setAnnotateTarget({ scope: 'day_metric', localDate, metric: 'daily_spo2' })} />
              )}
            </StatTile>
          )}
        </MetricCard>

        {/* label is its own catalogue string, not health.dailySpo2.label reused: a second card
            sharing "Daily oxygen saturation" would make a label lookup by exact text ambiguous,
            the same collision Dashboard.tsx's own comment on INSIGHTS explains at more length. */}
        <InsightCard insight={dailySpo2Insight.data} query={dailySpo2Insight} metric="daily_spo2" span={12}
          label={t('health.insights.dailySpo2')} formatValue={dailySpo2InsightFormat} polarity="higher-is-better" />
      </CardGrid>
      {annotateTarget && <AnnotatePanel target={annotateTarget} onClose={() => setAnnotateTarget(null)} />}
    </>
  )
}
