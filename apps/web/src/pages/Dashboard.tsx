import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { METRICS } from '@haelan/core/metrics'
import type { DailyAgg } from '@haelan/core/metrics'
import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { StatTile } from '../components/StatTile.js'
import { MetricCard } from '../components/MetricCard.js'
import { InsightCard } from '../components/InsightCard.js'
import { EmptyState } from '../components/EmptyState.js'
import { Loading } from '../components/Loading.js'
import { ErrorState } from '../components/ErrorState.js'
import { ControlRow } from '../components/ControlRow.js'
import { AnnotatePanel } from '../components/AnnotatePanel.js'
import type { AnnotateTarget } from '../components/AnnotatePanel.js'
import { Sparkline } from '../charts/Sparkline.js'
import { HeartRateRange } from '../charts/HeartRateRange.js'
import { Hypnogram } from '../charts/Hypnogram.js'
import { SleepSchedule } from '../charts/SleepSchedule.js'
import { localMinutesOf, inWindow, withinSchedule, DEFAULT_WINDOW } from '../charts/schedule.js'
import { usePageControls } from '../controls/usePageControls.js'
import { deepLink } from '../controls/deepLink.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { Link } from '../router.js'
import { useSession } from '../auth/session.js'
import { denseSeries, useSeries } from '../data/useSeries.js'
import type { SeriesPoint } from '../data/useSeries.js'
import { useBaseline } from '../data/useBaseline.js'
import { useInsight } from '../data/useInsight.js'
import { useNights } from '../data/useNights.js'
import type { Night } from '../data/useNights.js'
import { useSyncStatus } from '../data/useSyncStatus.js'
import { useAnnotations } from '../data/useAnnotations.js'
import { overridesByMetric, annotationsFor } from '../data/chartAnnotations.js'
import { useDayAnnotations, annotationsWithDay } from '../data/dayAnnotations.js'
import { useMetricGroups } from '../data/useMetricGroups.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { wornOn } from '../data/emptyState.js'
import { distinctSources, exportPathFor } from '../data/pageShell.js'
import { formatClock, formatDuration, deltaFor, formatMetricValue } from '../format.js'

// /series takes a repeated metric parameter but exactly one `agg` for the whole call
// (requireMetricAndAgg in packages/core/src/query/personQuery.ts checks every metric against
// that same value), and a metric only has rows under the aggs its own catalogue entry lists. So
// "one request per card" is not achievable here, and one request for everything is not achievable
// either: what is achievable, and what this page actually does, is one request per distinct agg,
// with every metric that shares an agg riding along. Five requests below, one each for sum, last,
// mean, min and max.
//
// Checked against packages/core/src/derive/metrics.ts rather than against the card labels:
// 'sleep_minutes' is not a metric the catalogue defines, so this uses 'sleep_asleep_minutes', the
// real id for the summed minutes a night's sleep segments cover. 'steps', 'resting_heart_rate',
// 'heart_rate', 'sleep_bedtime_minutes' and 'sleep_waketime_minutes' are real ids as written. Per
// the catalogue: steps and sleep_asleep_minutes are TOTAL metrics (aggs: ['sum']);
// resting_heart_rate, sleep_bedtime_minutes and sleep_waketime_minutes are once-a-day readings
// (aggs: ['last'] only, no 'mean' to average since there is only ever one row a day to begin
// with); heart_rate is intraday (aggs: ['min', 'mean', 'max', 'p50', 'count']). The mean-HR tile
// asks for 'mean', which is what its own label ("Mean heart rate") and basis line ("mean, ...
// days") claim to show. The heart rate range card draws all three of min, mean and max, which its
// own basis line has always claimed ("daily minimum, mean and maximum"): a chart naming three
// series while drawing one would be the same kind of untrue basis line this project refuses to
// draw for an empty state, so 'min' and 'max' are two further requests rather than two blank
// channels. sleep_bedtime_minutes and sleep_waketime_minutes ride the same 'last' request as
// resting_heart_rate; see the comment where they are read for why the sleep schedule card uses
// these instead of /sleep/nights.
//
// Which agg a card shows is this page's decision, so REQUESTS is declared here: the catalogue
// says which aggs a metric HAS rows under, never which of them a given card is SHOWING, and
// heart_rate carries five while three separate cards want three of them. What the catalogue does
// settle is whether a pairing is answerable at all, and `under` below is where that is asked.
export const REQUESTS = {
  sum: ['steps', 'sleep_asleep_minutes'],
  last: ['resting_heart_rate', 'sleep_bedtime_minutes', 'sleep_waketime_minutes'],
  mean: ['heart_rate'],
  min: ['heart_rate'],
  max: ['heart_rate'],
} as const satisfies Partial<Record<DailyAgg, readonly string[]>>

/**
 * The metrics to actually put on the wire under one agg, filtered against the catalogue.
 *
 * This page used to restate the catalogue instead ("steps and sleep_asleep_minutes are TOTAL
 * metrics, resting_heart_rate is a once-a-day reading"), because apps/web could not depend on
 * @haelan/core at all: its one export reached better-sqlite3 and argon2 through the barrel, native
 * modules no browser bundle can carry. @haelan/core/metrics is the second entry point that ended
 * that, and reading the real thing matters more here than tidiness does. /series takes one agg for
 * a whole call and rejects the call outright if any metric in it has no rows under that agg, so an
 * unanswerable pairing does not cost one card its number: it 500s the request and blanks every
 * card riding along with it, three of them in the 'last' group. Dropping the pair here keeps the
 * request valid and leaves the one bad card to fall through to its own empty state, which is a
 * failure this page knows how to render.
 *
 * It should never come to that: dashboard-metrics.test.ts holds every pairing above to the
 * catalogue, so a metric renamed or an agg dropped upstream is a red test rather than a card that
 * quietly went blank.
 */
function under(agg: keyof typeof REQUESTS): string[] {
  return REQUESTS[agg].filter((metric) => METRICS[metric]?.aggs.includes(agg) ?? false)
}

// The three insight cards' (metric, agg) pairs, curated rather than derived from REQUESTS/GROUPS
// above: sleep_asleep_minutes, resting_heart_rate and steps are the three metrics this page
// already leads with, and the three where a period over period change is something a person acts
// on. That is an editorial choice stated here rather than a rule this file derives from the
// catalogue the way under() does below, and it is why these three and not a fourth or fifth.
//
// Exported, and read from below rather than re-typed into each useInsight call, so
// dashboard-metrics.test.ts can hold these three to the catalogue the same way it already holds
// REQUESTS: unlike REQUESTS, these three never pass through under()'s own filter, so nothing
// caught a metric/agg pairing the catalogue stopped answering until this table gave that test
// something to quantify over.
//
// agg matches what each metric's own tile below already asks /series for: 'sum' for steps and
// sleep_asleep_minutes (SUM_METRICS, REQUESTS.sum), 'last' for resting_heart_rate (LAST_METRICS,
// REQUESTS.last), the once a day reading rather than the mean the tile itself derives client side
// from those same points.
export const INSIGHTS = {
  steps: { metric: 'steps', agg: 'sum' },
  restingHr: { metric: 'resting_heart_rate', agg: 'last' },
  sleep: { metric: 'sleep_asleep_minutes', agg: 'sum' },
} as const satisfies Record<string, { metric: string, agg: DailyAgg }>

const SUM_METRICS = under('sum')
const LAST_METRICS = under('last')
const MEAN_METRICS = under('mean')
const MIN_METRICS = under('min')
const MAX_METRICS = under('max')

// The sum/last/mean groups useMetricGroups issues one request per, `metrics` and `covers` split
// the same way `under` and REQUESTS already were: `metrics` is the catalogue-filtered list that
// actually reaches /series, `covers` is REQUESTS' own unfiltered list, so a card naming a pairing
// `under` dropped still resolves to the request its group would have ridden in and renders its own
// empty state instead of throwing. Module level, not built inside the component: useMetricGroups
// maps one useSeries call per entry here, and it has to see the same array on every render for
// React to keep the hooks it calls in the same order.
//
// min and max are not here. Both share heart_rate's name with the mean group above, and
// useMetricGroups resolves a metric to a group by name alone, so a metric appearing in two groups
// would always resolve to whichever came first; heart_rate's three distinct series (min, mean,
// max) need three distinct queries kept apart by more than a shared metric name, which is why they
// stay their own useSeries calls below rather than folding into this list.
const GROUPS: readonly MetricGroup[] = [
  { agg: 'sum', metrics: SUM_METRICS, covers: REQUESTS.sum },
  { agg: 'last', metrics: LAST_METRICS, covers: REQUESTS.last },
  { agg: 'mean', metrics: MEAN_METRICS, covers: REQUESTS.mean },
]

// One array for every prop and every fallback that is deliberately empty. A fresh [] on every
// render gives the chart's `build` callback a new identity, which useChart reads as "rebuild", so
// two literals in one JSX attribute list were enough to dispose and re-initialise an echarts
// instance on every commit of this page.
//
// Frozen because it is shared: `naps` below hands it out under a mutable type, and a consumer
// that pushed into that one array would be writing into `annotations`, `excluded` and every other
// user of this same array at once. Freezing turns that from a silent corruption into a throw at
// the line that did it.
//
// Only min/max heart rate, the nights query and the sleep schedule's naps field still fall back to
// this one: useMetricGroups carries its own frozen empty for every metric it resolves, so nothing
// backed by `metricGroups.pointsOf` reaches this file's copy any more.
const EMPTY = Object.freeze([]) as never[]

const values = (points: SeriesPoint[]): number[] =>
  points.map((p) => p.value).filter((v): v is number => v !== null)

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

// Every calendar date from `from` to `to`, inclusive. /series and /sleep/nights both drop a day
// entirely rather than sending a null row for it (see useSeries.ts and useNights.ts), so a chart
// that plots by array position - the heatmap's weeks and the range chart's day axis - needs this
// to rebuild the full calendar and place an absence where a source is silent, not to quietly
// shrink the axis to only the days that reported something.
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
// that import for the one type this file needs from it.
type Stage = 'deep' | 'light' | 'rem' | 'awake'

// packages/core/src/derive/sleep.ts's ASLEEP_STAGES and AWAKE_STAGE are the only recognised
// values a segment's stage carries ('DEEP', 'LIGHT', 'REM', 'AWAKE'); the derive layer itself
// refuses to count anything outside that vocabulary toward either asleep or awake (sleep.ts:180)
// rather than guessing. A segment whose stage this app does not recognise is dropped for the same
// reason, leaving a visible gap in the hypnogram, rather than drawn, coloured and tabulated as
// LIGHT: a device reporting a value nobody staged is not the same case as an internal lane index
// falling out of range, which is the only place Hypnogram itself still falls back.
function stageOf(raw: string): Stage | null {
  const known: Record<string, Stage> = { DEEP: 'deep', LIGHT: 'light', REM: 'rem', AWAKE: 'awake' }
  return known[raw] ?? null
}

// /sleep/nights returns one row per (localDate, sourceId), so two sources reporting sleep on the
// same date is two rows for what is, to a reader, one night. Collapsed to one per date with a
// stated rule rather than left to whatever order the route happens to return: the longest
// duration entry wins, since a second device capturing the same night is more likely to hold a
// shorter, partial recording than the source that actually stayed on through it.
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

export function Dashboard() {
  const { t, i18n } = useTranslation()
  const session = useSession()
  const controls = usePageControls()
  const period = `${controls.from} ${t('common.to')} ${controls.to}`

  // The control row's source selector has to be read off the unfiltered (merged-preferring) view,
  // not off whatever source is currently selected: rollup.ts writes sourceMix: null for every per
  // source rollup (packages/core/src/derive/rollup.ts:154, and exercise.ts:68 reads it the same
  // way), and only mergeDay's merged rows carry a real mix (merge.ts's encodeMix, called
  // unconditionally there). Feeding distinctSources the range scoped queries below therefore
  // worked only for the one reader who had never touched the selector: the moment somebody picked
  // a real device, every series request became scoped to that device, none of the returned rows
  // carried a sourceMix, distinctSources returned nothing, the source fell back to the sentinel,
  // and the select silently relabelled itself "All sources" while the charts above it kept showing
  // the device filtered numbers, no way back to another device short of hand editing the URL. So
  // this is its own query, pinned to the all sources sentinel regardless of what the reader has
  // chosen. When the reader has not touched the selector this key is identical to sumSeries's own
  // key (both omit the source parameter and both let preferMerged answer) and React Query serves
  // it from that same cache entry rather than issuing a second request; the extra request only
  // happens while a device filter is actually active, which is exactly the state this exists to
  // recover from.
  //
  // It runs before the range scoped queries because it is what tells them which source to ask
  // for: a link naming a source this person does not have used to correct only the select while
  // every card underneath queried the foreign value.
  const sourceEnumeration = useSeries([...SUM_METRICS], { from: controls.from, to: controls.to, source: ALL_SOURCES }, 'sum')
  const sources = distinctSources([sourceEnumeration])
  const source = resolveSource(controls.source, [ALL_SOURCES, ...sources])
  const range = { from: controls.from, to: controls.to, source }
  // One state object from here down, so the row, the card links and every request are talking
  // about the same source.
  const resolved = { ...controls, source }

  // The day and metric a chart's own click named, or null when no panel is open. One slot for the
  // whole page rather than one per chart: only ever one panel can be open at a time, since opening
  // a second would mean the first's click had already been handed off, so a single nullable target
  // says everything a per-chart flag would and cannot drift out of sync with itself.
  const [annotateTarget, setAnnotateTarget] = useState<AnnotateTarget | null>(null)
  const overridesQuery = useAnnotations(range)
  // Grouped by metric once per render of the overrides list, not once per chart: every tile() and
  // the heart rate range card below call annotationsFor on the same Map, and Map.get returns the
  // exact same array instances every time, which is what keeps a chart's own build callback from
  // seeing a new identity (and disposing itself, see chart-lifecycle.test.tsx) on a render where
  // the overrides list itself did not change.
  const overridesByMetricMap = useMemo(
    () => overridesByMetric(overridesQuery.overrides.data?.items ?? []),
    [overridesQuery.overrides.data],
  )
  // Notes and events, flattened into the same day level shape every chart's own annotations prop
  // already takes and merged onto overridesByMetricMap: neither carries a metric of its own, so
  // dayAnnotations reaches every chart on the page alike, and dayAnnotationsByMetric is what
  // tile()/the heart rate range block below actually reads through annotationsWithDay. Both stay
  // memoised inside useDayAnnotations itself; see its own comment for why this used to be two
  // useMemo calls copied into all four pages.
  const { dayAnnotations, dayAnnotationsByMetric } =
    useDayAnnotations(overridesQuery.notes, overridesQuery.events, overridesByMetricMap)

  // Fixed groups, not derived from a response: useMetricGroups runs one useSeries call per entry
  // in GROUPS, in the same order, on every render regardless of what any of them returns. min and
  // max stay their own calls beside it; see GROUPS' own comment for why heart_rate cannot share a
  // metric-keyed group with the mean series above without the two colliding.
  const metricGroups = useMetricGroups(GROUPS, range)
  // By agg, not by naming one member metric as a stand in for its group: queryFor('steps') reads
  // right here but ties this line to a metric that has nothing to do with what it actually checks
  // (whether the sum request as a whole is loading), and dropping 'steps' from REQUESTS.sum for a
  // reason with nothing to do with this line would silently break it. queryForAgg asks for the
  // group itself. (metricGroups.queries by position was the other option and is not it: queries is
  // a plain array under noUncheckedIndexedAccess, so every element reads as possibly undefined even
  // though GROUPS' length is fixed.)
  const sumSeries = metricGroups.queryForAgg('sum')
  const lastSeries = metricGroups.queryForAgg('last')
  const meanSeries = metricGroups.queryForAgg('mean')
  const minHrSeries = useSeries([...MIN_METRICS], range, 'min')
  const maxHrSeries = useSeries([...MAX_METRICS], range, 'max')
  // 'mean' explicitly: useBaseline defaults to 'sum', which heart_rate's catalogue entry does not
  // list, and the default would 400 the request (ConfigError, requireSource/requireMetricAndAgg)
  // the same way it would for /series.
  // Anchored on the range end, not on controls.anchor: baselineWindow reads the sixty days
  // before `on`, and the chart under this band draws from..to. Anchoring on controls.to rather
  // than controls.anchor is what lets the basis line state when the window actually ends: a Year
  // view's anchor can sit months away from the range the chart draws, and the basis line used to
  // report that anchor date instead of the one the drawn band was really computed against.
  const hrBaseline = useBaseline('heart_rate', controls.to, source, 'mean')
  const nights = useNights(range)
  const syncStatus = useSyncStatus()

  // /insights takes exactly one metric and one agg per call and, unlike /series, does not batch, so
  // each of the three below is its own request rather than a shared one: three requests added on
  // top of whatever GROUPS above already issues, not multiplied against the cards. See INSIGHTS'
  // own comment above for the three metrics themselves and their aggs.
  const insightRange = { from: controls.from, to: controls.to }
  const stepsInsight = useInsight(INSIGHTS.steps.metric, INSIGHTS.steps.agg, insightRange, source)
  const restingHrInsight = useInsight(INSIGHTS.restingHr.metric, INSIGHTS.restingHr.agg, insightRange, source)
  const sleepInsight = useInsight(INSIGHTS.sleep.metric, INSIGHTS.sleep.agg, insightRange, source)

  // Both cards below whose tile carries something InsightCard's own default (formatMetricValue at
  // the catalogue's stored-unit precision) does not. `insight.current`/`.previous`/`.delta` are
  // each a mean over the days in the period regardless of agg (see InsightCard.tsx's own comment,
  // comparePeriods's meanOf), which is a duration in raw minutes for sleep_asleep_minutes and a
  // plain number with no unit suffix for resting_heart_rate; formatValue is what lets this card
  // read the same as the tile above it (formatDuration, the same call the sleep tile's own
  // headline value makes; the bpm suffix StatTile's own `unit` prop adds beside the resting heart
  // rate tile's value) rather than a unitless or wrongly-shaped number beside one that carries a
  // unit. steps carries neither below: its tile prints a plain, unitless number the same way
  // formatMetricValue already would, so it takes InsightCard's default.
  const restingHrFormat = (value: number | null, absent: string): string =>
    value === null ? absent : `${formatMetricValue(value, 'resting_heart_rate', i18n.language, absent)} ${t('dashboard.units.bpm')}`
  const sleepFormat = (value: number | null, absent: string): string =>
    value === null ? absent : formatDuration(value)

  // Minutes ago, not a timestamp, because syncedAgo's own message reads "Synced N min ago". Null
  // rather than zero when no run has ever finished: the row has its own copy for that now, and
  // for the moment before the status query has answered.
  const syncedMinutesAgo = syncStatus.data?.lastFinishedAtMs != null
    ? Math.max(0, Math.round((Date.now() - syncStatus.data.lastFinishedAtMs) / 60_000))
    : null
  const personId = session.data?.personId
  const exportPath = personId !== undefined ? exportPathFor(personId, SUM_METRICS, 'sum', range) : undefined

  // Every calendar day in the range, computed once: the dense denominator every basis line counts
  // against, and the axis every by-day chart on this page is now drawn along. It has to be declared ahead
  // of the sparklines below rather than after them, which is where it used to sit, because those
  // are built against it now.
  const rangeDates = useMemo(() => datesBetween(controls.from, controls.to), [controls.from, controls.to])

  // Everything from here to the return is memoised on the query data it comes from, and nothing
  // below it constructs an array or an object inline in JSX. useChart keys its effect on `build`
  // and disposes the chart in that effect's cleanup, and every chart's `build` is a useCallback
  // over its own data props, so one freshly constructed array is enough to tear down and rebuild
  // an echarts instance. With eight queries settling at different moments the page commits about
  // eight times on a single load, and each commit was disposing and re-initialising five charts.
  const sparklines = useMemo(() => {
    const out = new Map<string, { values: (number | null)[], labels: string[] }>()
    for (const metric of [...SUM_METRICS, ...LAST_METRICS, ...MEAN_METRICS]) {
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
    // The three query results metricGroups.pointsOf reads for these metrics, named directly:
    // metricGroups itself is rebuilt every render and is not a dependency worth tracking.
  }, [rangeDates, sumSeries.data, lastSeries.data, meanSeries.data])

  // The denominator is the days in the period, not the days that answered. /series omits a day
  // with no row entirely, so points.length is "days that reported", and a month missing eleven of
  // them read "20 of 20 days, 0 days not worn". The reasoning was first written for the heatmap
  // that used to live here (now Activity.tsx's) and applied to one card out of five. `total` is
  // the one figure MetricCard cannot compute for itself (it knows a metric and its points, not
  // the calendar range those points were requested against), so it is the one field every tile()
  // call below hands in through basisValues.
  //
  // MetricCard now owns the rest of what used to live here: the error-before-pending order, the
  // empty-state gate, and the worn/count/reported arithmetic and the basis/basisWorn key choice
  // built on it (see MetricCard.tsx, moved there comments included). tile() is left as the JSX
  // assembly its four callers share, not a second copy of that gating.
  // span and after (the "View X" link) are threaded straight to MetricCard: it owns the Card shell
  // now, so this outer function is the only place left that can still hand the link the same span
  // as the card it sits beside, and after keeps it visible through every branch MetricCard renders,
  // not just the data one.
  const tile = (
    metric: string, span: number, labelKey: string, basisKey: string, basisWornKey: string,
    chartLabelKey: string, unitKey: string,
    format: (points: SeriesPoint[]) => string,
    direction: 'higher-is-better' | 'lower-is-better' | 'neutral',
    after: ReactNode,
    unit?: string,
  ) => {
    const points = metricGroups.pointsOf(metric)
    const { excluded } = annotationsFor(overridesByMetricMap, metric)
    const annotations = annotationsWithDay(dayAnnotationsByMetric, dayAnnotations, metric)
    return (
      <MetricCard metric={metric} span={span} basisPlacement="body" query={metricGroups.queryFor(metric)} points={points}
        basisKey={basisKey} basisWornKey={basisWornKey} basisValues={{ total: rangeDates.length }}
        after={after}>
        {(basis) => (
          // trend() itself answers "no delta" (undefined) for a window with too few points to
          // compare, which is the day range (exactly one point), so there is nothing left for
          // this call site to guard against.
          <StatTile label={t(labelKey)} value={format(points)} unit={unit}
            basis={basis}
            delta={deltaFor(t, metric, values(points), direction)}>
            <Sparkline values={sparklines.get(metric)!.values} labels={sparklines.get(metric)!.labels} metric={metric}
              label={t(chartLabelKey, { period })} unit={t(unitKey)}
              annotations={annotations} excluded={excluded}
              onPointClick={(localDate) => setAnnotateTarget({ localDate, metric })} />
          </StatTile>
        )}
      </MetricCard>
    )
  }

  // Heart rate range: one day per date in range, min/mean/max looked up by localDate rather than
  // zipped by array position, because each of the three requests can be silent on a different day
  // (a source that only samples during waking hours never reports a night-time minimum) and the
  // three arrays are not guaranteed to line up index for index.
  const meanHrPoints = metricGroups.pointsOf('heart_rate')
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
  // Map.get on overridesByMetricMap, stable across a render that changed nothing (see that map's
  // own comment): the same object reaches this chart on every render until the overrides list
  // itself changes.
  const heartRateOverrides = annotationsFor(overridesByMetricMap, 'heart_rate')
  // The basis line's band clause tracks whether heartRateBand is actually defined above, rather
  // than a single static string claiming a band that a thin or absent baseline never draws.
  const heartRateBasisKey = hrBaseline.isError
    // "No baseline yet" would be a claim about the person's history. A request that failed says
    // nothing about how much history there is.
    ? 'dashboard.heartRateRange.basisBaselineUnknown'
    // Ahead of the null test for the same reason: /baselines settles independently of the three
    // heart rate series MetricCard gates on, so `data` is undefined for a while after this card
    // has drawn, and reading that as "no baseline yet" is the claim the comment above refuses.
    : hrBaseline.isPending
      ? 'dashboard.heartRateRange.basisBaselinePending'
      : rawBaseline === null
        ? 'dashboard.heartRateRange.basisNoBaseline'
        : rawBaseline.thin
          ? 'dashboard.heartRateRange.basisThin'
          : 'dashboard.heartRateRange.basis'
  // All three requests, not only the mean: a card drawing three series has not settled until
  // the last of them has, and has failed if any of them did. The empty check itself, and the
  // baseline omission it depends on, now live in MetricCard: this composite query is only built
  // here because MetricCard takes one query object, not three.
  const heartRateFailed = meanSeries.isError || minHrSeries.isError || maxHrSeries.isError
  const retryHeartRate = () => {
    void meanSeries.refetch()
    void minHrSeries.refetch()
    void maxHrSeries.refetch()
  }
  const heartRatePending = meanSeries.isPending || minHrSeries.isPending || maxHrSeries.isPending

  // Sleep stages (hypnogram): the most recent night in range, one per source collapsed to one per
  // date. Pending-tolerant the same way tile() is, rather than flashing "no data" the instant
  // between mount and the request resolving.
  const nightItems = nights.data?.items ?? EMPTY
  const lastNight = useMemo(() => oneNightPerDate(nightItems).at(-1) ?? null, [nightItems])
  const hypnogramSegments = useMemo(() => (lastNight === null ? EMPTY : lastNight.segments
    .map((s) => ({
      stage: stageOf(s.stage),
      from: Math.round((s.startMs - lastNight.startMs) / 60_000),
      to: Math.round((s.endMs - lastNight.startMs) / 60_000),
    }))
    .filter((s): s is { stage: Stage, from: number, to: number } => s.stage !== null)), [lastNight])
  // Inherits the same nap contamination the comment below documents for /sleep/nights: startMs is
  // the earliest instant across every session sharing this night's date and source, so a 13:00
  // nap sharing the date still becomes this label's "Bed 13:00" rather than the real bedtime.
  // Known, not fixed here: fixing it means the hypnogram card gaining the same /series-based
  // bedtime this schedule card already switched to, which is more than this label alone needs.
  const lastNightBedMinutes = lastNight === null
    ? null : inWindow(localMinutesOf(lastNight.localDate, lastNight.startMs, lastNight.startOffsetMinutes), DEFAULT_WINDOW)
  const startLabel = lastNightBedMinutes !== null
    ? t('common.bedLabel', { time: formatClock(lastNightBedMinutes) })
    : t('common.bedTimeNotRecorded')

  // Sleep schedule: sleep_bedtime_minutes and sleep_waketime_minutes, riding the same 'last'
  // request as resting_heart_rate, rather than /sleep/nights. Two reasons. First, /series's own
  // merge (personQuery.series's preferMerged) gives one row per date regardless of how many
  // sources reported, where /sleep/nights gives one row per (localDate, sourceId) and has no
  // merge of its own (the hypnogram above still needs it for segments, which is not something
  // /series carries, so it collapses devices itself instead). Second, /sleep/nights groups every
  // sleep session sharing a date and source into one entry, so a startMs/endMs span drawn from it
  // includes any nap that landed in the same local date; sleep_bedtime_minutes and
  // sleep_waketime_minutes are pushed in packages/core/src/derive/sleep.ts from the `night` group
  // assembleNights already separated from `naps`, so they do not carry that contamination.
  const bedtimePoints = metricGroups.pointsOf('sleep_bedtime_minutes')
  const waketimePoints = metricGroups.pointsOf('sleep_waketime_minutes')
  const scheduleNights = useMemo(() => {
    const bedtimeByDate = new Map(bedtimePoints.map((p) => [p.localDate, p]))
    const waketimeByDate = new Map(waketimePoints.map((p) => [p.localDate, p]))
    const dates = [...new Set([...bedtimeByDate.keys(), ...waketimeByDate.keys()])].sort()
    return dates.map((date) => {
      const bedPoint = bedtimeByDate.get(date)
      const wakePoint = waketimeByDate.get(date)
      // DEFAULT_WINDOW rather than Sleep.tsx's WIDE_WINDOW: a span this compact card's noon to
      // noon axis cannot hold comes back as an absence dot here, which is a defensible trade on a
      // four line summary card and the wrong one on the page whose whole subject is sleep.
      const { bed, wake } = withinSchedule(
        bedPoint?.value ?? null, wakePoint?.value ?? null, DEFAULT_WINDOW,
      )
      return {
        date,
        bed,
        wake,
        // Neither metric carries naps (see above), and there is no other route this call site can
        // read a nap's clock time from, so this stays empty rather than a guess.
        naps: EMPTY as number[],
      }
    })
  }, [bedtimePoints, waketimePoints])
  // The nights this card actually draws a bed and a wake for. withinSchedule nulls out any
  // night the axis cannot place honestly and SleepSchedule draws those as absence dots, so
  // counting the dates would claim a bed and wake time for a row that shows neither.
  const drawnNights = scheduleNights.filter((n) => n.bed !== null && n.wake !== null).length

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('dashboard.title')}</h1>
      <ControlRow controls={resolved} sources={sources} syncedMinutesAgo={syncedMinutesAgo} exportPath={exportPath} />
      <div className="grid">
        {tile('steps', 3, 'dashboard.steps.label', 'dashboard.steps.basis', 'dashboard.steps.basisWorn',
          'dashboard.steps.chartLabel', 'dashboard.units.steps',
          (p) => formatMetricValue(values(p).reduce((a, b) => a + b, 0), 'steps', i18n.language, ''), 'higher-is-better',
          <Link to={deepLink('/activity', resolved)} className="card-link">
            {t('dashboard.steps.viewAll')}
          </Link>)}
        {tile('resting_heart_rate', 3, 'dashboard.restingHr.label', 'dashboard.restingHr.basis',
          'dashboard.restingHr.basisWorn', 'dashboard.restingHr.chartLabel',
          'dashboard.units.beatsPerMinute',
          (p) => formatMetricValue(mean(values(p)), 'resting_heart_rate', i18n.language, ''), 'lower-is-better',
          <Link to={deepLink('/recovery', resolved)} className="card-link">
            {t('dashboard.restingHr.viewAll')}
          </Link>, t('dashboard.units.bpm'))}
        {tile('sleep_asleep_minutes', 3, 'dashboard.sleep.label', 'dashboard.sleep.basis',
          'dashboard.sleep.basisWorn', 'dashboard.sleep.chartLabel',
          'dashboard.units.minutesAsleep',
          (p) => formatDuration(mean(values(p))), 'higher-is-better',
          <Link to={deepLink('/sleep', resolved)} className="card-link">
            {t('dashboard.sleep.viewAll')}
          </Link>)}
        {tile('heart_rate', 3, 'dashboard.meanHr.label', 'dashboard.meanHr.basis',
          'dashboard.meanHr.basisWorn', 'dashboard.meanHr.chartLabel',
          'dashboard.units.beatsPerMinute',
          (p) => formatMetricValue(mean(values(p)), 'heart_rate', i18n.language, ''), 'neutral',
          <Link to={deepLink('/recovery', resolved)} className="card-link">
            {t('dashboard.meanHr.viewAll')}
          </Link>, t('dashboard.units.bpm'))}

        {/* The three insight cards: see INSIGHTS' own comment above for why these three and why
            one request each. label is its own catalogue string rather than the plain metric label
            (dashboard.steps.label etc.) reused: dashboard-cards.test.tsx's own cardFor() looks up
            a card by its exact label text, in a test that predates this task, and a second card
            sharing "Steps" made that lookup ambiguous between the tile and this card (caught by
            dashboard-cards.test.tsx's own "labels each insight card distinctly" test). */}
        <InsightCard insight={stepsInsight.data} query={stepsInsight} metric="steps" span={4}
          label={t('dashboard.insights.steps')} />
        <InsightCard insight={restingHrInsight.data} query={restingHrInsight} metric="resting_heart_rate" span={4}
          label={t('dashboard.insights.restingHr')} formatValue={restingHrFormat} />
        <InsightCard insight={sleepInsight.data} query={sleepInsight} metric="sleep_asleep_minutes" span={4}
          label={t('dashboard.insights.sleep')} formatValue={sleepFormat} />

        {/* basisKey and basisWornKey are the same string here on purpose: this card's basis is a
            four way choice driven by the baseline's own validity (unknown, absent, thin, real),
            not by whether heart_rate carries a wear signal (it does, so MetricCard would otherwise
            always pick basisWornKey), and MetricCard has no third slot for that choice. Collapsing
            both props to the one key heartRateBasisKey already selected means MetricCard's own
            wear/plain switch has nothing left to decide between; whichever branch it takes renders
            the same text. worn/count/reported still land in the call MetricCard makes for the wear
            branch, but heartRateBasisKey's four templates reference none of them, so they are
            unused interpolation values, not a second, competing basis. baseline stays unset here,
            the same omission the card made by hand before: a thin baseline should blank only the
            band this chart draws around its lines, not the lines themselves, and passing baseline
            through would hand that decision to emptyStateFor's own insufficient state instead. */}
        <MetricCard metric="heart_rate" span={8} label={t('dashboard.heartRateRange.label')} basisPlacement="header"
          query={{ isError: heartRateFailed, isPending: heartRatePending, refetch: retryHeartRate }}
          points={meanHrPoints}
          basisKey={heartRateBasisKey} basisWornKey={heartRateBasisKey} basisValues={{ on: controls.to }}>
          {() => (
            // HeartRateRange has taken annotations/excluded since D1; heartRateOverrides is the
            // same lookup tile() uses for every other card, read here under the metric this chart
            // itself plots.
            <HeartRateRange days={heartRateDays} baseline={heartRateBand}
              annotations={annotationsWithDay(dayAnnotationsByMetric, dayAnnotations, 'heart_rate')}
              excluded={heartRateOverrides.excluded}
              label={t('dashboard.heartRateRange.chartLabel', { period })}
              onPointClick={(localDate) => setAnnotateTarget({ localDate, metric: 'heart_rate' })} />
          )}
        </MetricCard>
        <Card span={4} label={t('dashboard.flaggedDays.label')}>
          <EmptyState title={t('dashboard.flaggedDays.emptyTitle')} detail={t('dashboard.flaggedDays.emptyDetail')} />
        </Card>

        {/* The date comes off the night being drawn, never off the range end: this card used to
            head an empty state with the range's own last date, naming a night it was not drawing
            and had no row for, which is what the guard below avoids by naming lastNight's own
            date rather than the range end.
            Not a MetricCard: gated on a night from useNights, not a metric and its points. */}
        <Card span={7} label={t('dashboard.sleepStages.label')}
          basis={nights.isError || lastNight === null
            ? undefined
            : t('dashboard.sleepStages.basis', { date: lastNight.localDate })}>
          {nights.isError ? <ErrorState onRetry={() => void nights.refetch()} />
            : nights.isPending ? <Loading /> : lastNight === null ? (
            <EmptyState title={t('emptyState.no_data.title')} detail={t('emptyState.no_data.detail')} />
          ) : (
            <Hypnogram segments={hypnogramSegments} startLabel={startLabel}
              label={t('dashboard.sleepStages.chartLabel', { date: lastNight.localDate })} />
          )}
        </Card>
        {/* metric is sleep_bedtime_minutes only to pick the plain key: neither bedtime nor
            waketime carries a wear signal (every sleep metric says false, see coverageIsMeaningful),
            so MetricCard always resolves to basisKey here, and basisWornKey is never reached; it is
            handed the same string only because the prop is required. points concatenates both
            metrics' rows rather than naming one: scheduleNights.length === 0, the old empty test,
            is true exactly when both bedtimePoints and waketimePoints are empty, which is exactly
            what points.length === 0 reads once the two are joined, so the gate does not narrow to
            "bedtime is empty" the way naming one metric alone would. count is drawnNights, not the
            wear clause's own count, which is what un-reserving count on the plain key is for. */}
        <MetricCard metric="sleep_bedtime_minutes" span={5} label={t('dashboard.sleepSchedule.label')} basisPlacement="header"
          query={lastSeries} points={[...bedtimePoints, ...waketimePoints]}
          basisKey="dashboard.sleepSchedule.basis" basisWornKey="dashboard.sleepSchedule.basis"
          basisValues={{ count: drawnNights }}>
          {() => <SleepSchedule nights={scheduleNights} showNaps={false} label={t('common.bedWakeChartLabel', { period })} />}
        </MetricCard>

        {/* The heatmap that used to sit here moved to Activity.tsx in M3d2: the Dashboard keeps
            its own steps tile above and loses the calendar drill-down, whose "View activity" deep
            link now lands somewhere that adds something instead of returning to this same page. */}
        <Card span={4} label={t('dashboard.recovery.label')}>
          <EmptyState title={t('dashboard.recovery.emptyTitle')}
            detail={t('dashboard.recovery.emptyDetail')} />
        </Card>

        <Card span={12} label={t('dashboard.anomalies.label')}>
          <EmptyState title={t('dashboard.anomalies.emptyTitle')} detail={t('dashboard.anomalies.emptyDetail')} />
        </Card>
      </div>
      {annotateTarget && <AnnotatePanel target={annotateTarget} onClose={() => setAnnotateTarget(null)} />}
    </>
  )
}
