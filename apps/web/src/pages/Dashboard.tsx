import { useMemo } from 'react'
import { METRICS } from '@haelan/core/metrics'
import type { DailyAgg } from '@haelan/core/metrics'
import type { UseQueryResult } from '@tanstack/react-query'
import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { StatTile } from '../components/StatTile.js'
import { MetricCard } from '../components/MetricCard.js'
import { EmptyState } from '../components/EmptyState.js'
import { Loading } from '../components/Loading.js'
import { ErrorState } from '../components/ErrorState.js'
import { ControlRow } from '../components/ControlRow.js'
import { Sparkline } from '../charts/Sparkline.js'
import { HeartRateRange } from '../charts/HeartRateRange.js'
import { Hypnogram } from '../charts/Hypnogram.js'
import { SleepSchedule, AXIS_MIN, AXIS_MAX } from '../charts/SleepSchedule.js'
import { ActivityHeatmap } from '../charts/ActivityHeatmap.js'
import { usePageControls } from '../controls/usePageControls.js'
import { deepLink } from '../controls/deepLink.js'
import { ALL_SOURCES, resolveSource } from '../controls/source.js'
import { Link } from '../router.js'
import { useSession } from '../auth/session.js'
import { useSeries } from '../data/useSeries.js'
import type { MetricSeries, SeriesPoint } from '../data/useSeries.js'
import { useBaseline } from '../data/useBaseline.js'
import { useNights } from '../data/useNights.js'
import type { Night } from '../data/useNights.js'
import { useSyncStatus } from '../data/useSyncStatus.js'
import { useMetricGroups } from '../data/useMetricGroups.js'
import type { MetricGroup } from '../data/useMetricGroups.js'
import { emptyStateFor, wornOn } from '../data/emptyState.js'
import type { EmptyStateKind } from '../data/emptyState.js'
import { formatClock, formatDuration, trend } from '../format.js'

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
// that pushed into that one array would be writing into `annotations`, `excluded` and every
// metric with no rows at the same time. Freezing turns that from a silent corruption into a
// throw at the line that did it.
const EMPTY = Object.freeze([]) as never[]

const values = (points: SeriesPoint[]): number[] =>
  points.map((p) => p.value).filter((v): v is number => v !== null)

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

// sourceMix is nullable, and when present is JSON this app did not itself just produce
// (packages/core/src/derive/merge.ts's encodeMix writes it, but a row from an older mapping
// version or a hand edited value is just a string as far as this reads it): a malformed value
// must not take the page down over what is, at worst, a temporarily incomplete source list.
function sourcesIn(raw: string | null): string[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((entry) => (entry !== null && typeof entry === 'object' ? (entry as { source?: unknown }).source : undefined))
    .filter((source): source is string => typeof source === 'string')
}

// The device names offered in the control row's source selector, pulled off whichever query
// results are passed in rather than a route of its own. Every caller must pass a query scoped to
// the all sources sentinel: see the comment at the one call site (sourceEnumeration, below) for
// why an ordinary range scoped query silently breaks this the moment a device filter is active.
function distinctSources(queries: readonly UseQueryResult<Record<string, MetricSeries>>[]): string[] {
  const found = new Set<string>()
  for (const query of queries) {
    for (const series of Object.values(query.data ?? {})) {
      for (const point of series.points) {
        for (const source of sourcesIn(point.sourceMix)) found.add(source)
      }
    }
  }
  return [...found].sort()
}

// The one download link the control row offers, built from the same SUM_METRICS group the steps
// and sleep tiles read. /export takes exactly one `agg` per call, the same restriction /series has
// (requireMetricAndAgg in packages/core/src/query/personQuery.ts), so one link cannot carry the
// five aggs this page fetches across; the primary totals are the ones a reader downloading "the
// raw numbers behind this page" is most likely to mean.
function exportPathFor(personId: string, range: { from: string, to: string, source: string }): string {
  const params = new URLSearchParams()
  for (const metric of SUM_METRICS) params.append('metric', metric)
  params.set('format', 'csv')
  params.set('agg', 'sum')
  params.set('from', range.from)
  params.set('to', range.to)
  params.set('source', range.source)
  return `/api/v1/p/${personId}/export?${params.toString()}`
}

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

// Minutes from the local midnight of `localDate`, negative before it: the convention
// packages/core/src/derive/localDay.ts sets and sleep_bedtime_minutes is stored in. Written here
// rather than imported because core has no such function to import; localDay.ts computes local
// dates and hours, not this offset. It is also not reachable: `metrics` is the only browser safe
// subpath @haelan/core publishes, and localDay.ts, pure though it is, has no entry point of its
// own yet.
function localMinutesOf(localDate: string, utcMs: number, offsetMinutes: number): number {
  const wall = utcMs + offsetMinutes * 60_000
  return Math.round((wall - Date.parse(`${localDate}T00:00:00Z`)) / 60_000)
}

// A night's localDate, and a sleep_bedtime_minutes/sleep_waketime_minutes row's date, are both the
// date the night ENDED (db/schema/derived.ts: "a night spanning midnight belongs to the morning";
// sync/runJob.ts sets it from localDateOf(endMs); the same convention is documented again on
// sleep_bedtime_minutes itself in packages/core/src/derive/metrics.ts: "an 23:30 bedtime is -30").
// So localMinutesOf(localDate, ...) measures a bed time from the WRONG midnight: a 23:20 bedtime
// comes back as -40, and SleepSchedule's axis runs noon to noon from a single midnight, the BED
// date's. A value that lands before noon in the wake-day frame needs a day added to land in the
// bed-day frame instead; a value already past noon (a genuine daytime nap, or an unusually late
// wake) is already correctly placed and must not be shifted, which is why this is conditional
// rather than a blanket +1440. Applied to bed, wake, and any other minutes-from-local-midnight
// value on its way to formatClock, which otherwise renders a negative bedtime as "-1:-40".
function inWindow(minutes: number): number {
  return minutes < AXIS_MIN ? minutes + 1440 : minutes
}

// inWindow corrects the common case (an evening bedtime, an early morning wake) with one +1440
// shift, but one shift cannot correct every case. A wake time that is itself past noon on the
// wake day (rare, but the catalogue does not rule it out) is left unshifted by inWindow, since it
// already reads as "past noon" without knowing it is on the wrong day, which draws a span that
// ends before it starts; and a bed time early enough that the night is longer than about
// fourteen hours still lands before noon after one shift, which draws below the grid entirely.
// Rather than trying to guess a second shift, this checks the result: a bed and wake that do not
// both land inside [AXIS_MIN, AXIS_MAX] with wake after bed are not something this axis can draw
// honestly, so both fall back to null, which SleepSchedule already renders as its no-data mark,
// the same as a night with no reading at all.
function withinSchedule(bed: number | null, wake: number | null): { bed: number | null, wake: number | null } {
  if (bed === null || wake === null) return { bed: null, wake: null }
  const inRange = (m: number) => m >= AXIS_MIN && m <= AXIS_MAX
  if (!inRange(bed) || !inRange(wake) || wake <= bed) return { bed: null, wake: null }
  return { bed, wake }
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

  // Fixed groups, not derived from a response: useMetricGroups runs one useSeries call per entry
  // in GROUPS, in the same order, on every render regardless of what any of them returns. min and
  // max stay their own calls beside it; see GROUPS' own comment for why heart_rate cannot share a
  // metric-keyed group with the mean series above without the two colliding.
  const metricGroups = useMetricGroups(GROUPS, range)
  // One metric per group, not metricGroups.queries by position: queries is a plain array under
  // noUncheckedIndexedAccess, so every element reads as possibly undefined even though GROUPS'
  // length is fixed. queryFor reads the same three query objects back by a name already in each
  // group's own covers list.
  const sumSeries = metricGroups.queryFor('steps')
  const lastSeries = metricGroups.queryFor('resting_heart_rate')
  const meanSeries = metricGroups.queryFor('heart_rate')
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

  // Minutes ago, not a timestamp, because syncedAgo's own message reads "Synced N min ago". Null
  // rather than zero when no run has ever finished: the row has its own copy for that now, and
  // for the moment before the status query has answered.
  const syncedMinutesAgo = syncStatus.data?.lastFinishedAtMs != null
    ? Math.max(0, Math.round((Date.now() - syncStatus.data.lastFinishedAtMs) / 60_000))
    : null
  const personId = session.data?.personId
  const exportPath = personId !== undefined ? exportPathFor(personId, range) : undefined

  // The active language, not a pinned locale: a bilingual app whose numbers only ever group like
  // English is not actually speaking Dutch when it renders Dutch.
  const groupNumber = (value: number) => value.toLocaleString(i18n.language)

  // Everything from here to the return is memoised on the query data it comes from, and nothing
  // below it constructs an array or an object inline in JSX. useChart keys its effect on `build`
  // and disposes the chart in that effect's cleanup, and every chart's `build` is a useCallback
  // over its own data props, so one freshly constructed array is enough to tear down and rebuild
  // an echarts instance. With eight queries settling at different moments the page commits about
  // eight times on a single load, and each commit was disposing and re-initialising five charts.
  // ActivityHeatmap memoises its calendar layout internally against exactly this, and handing it
  // a new `days` array defeated that memo from the outside.
  const sparklines = useMemo(() => {
    const out = new Map<string, { values: (number | null)[], labels: string[] }>()
    for (const metric of [...SUM_METRICS, ...LAST_METRICS, ...MEAN_METRICS]) {
      const points = metricGroups.pointsOf(metric)
      out.set(metric, { values: points.map((p) => p.value), labels: points.map((p) => p.localDate) })
    }
    return out
    // The three query results metricGroups.pointsOf reads for these metrics, named directly:
    // metricGroups itself is rebuilt every render and is not a dependency worth tracking.
  }, [sumSeries.data, lastSeries.data, meanSeries.data])

  // Every calendar day in the range, computed once: the dense denominator every basis line and
  // both by-position charts on this page count against.
  const rangeDates = useMemo(() => datesBetween(controls.from, controls.to), [controls.from, controls.to])

  // The denominator is the days in the period, not the days that answered. /series omits a day
  // with no row entirely, so points.length is "days that reported", and a month missing eleven of
  // them read "20 of 20 days, 0 days not worn". The reasoning was already written for the heatmap
  // and applied to one card out of five. `total` is the one figure MetricCard cannot compute for
  // itself (it knows a metric and its points, not the calendar range those points were requested
  // against), so it is the one field every tile() call below hands in through basisValues.
  //
  // MetricCard now owns the rest of what used to live here: the error-before-pending order, the
  // empty-state gate, and the worn/count/reported arithmetic and the basis/basisWorn key choice
  // built on it (see MetricCard.tsx, moved there comments included). tile() is left as the JSX
  // assembly its four callers share, not a second copy of that gating.
  const tile = (
    metric: string, labelKey: string, basisKey: string, basisWornKey: string,
    chartLabelKey: string, unitKey: string,
    format: (points: SeriesPoint[]) => string,
    direction: 'higher-is-better' | 'lower-is-better' | 'neutral',
    unit?: string,
  ) => {
    const points = metricGroups.pointsOf(metric)
    return (
      <MetricCard metric={metric} query={metricGroups.queryFor(metric)} points={points}
        basisKey={basisKey} basisWornKey={basisWornKey} basisValues={{ total: rangeDates.length }}>
        {(basis) => (
          // trend() itself answers "no delta" (undefined) for a window with too few points to
          // compare, which is the day range (exactly one point), so there is nothing left for
          // this call site to guard against.
          <StatTile label={t(labelKey)} value={format(points)} unit={unit}
            basis={basis}
            delta={trend(t, values(points), direction)}>
            <Sparkline values={sparklines.get(metric)!.values} labels={sparklines.get(metric)!.labels}
              label={t(chartLabelKey, { period })} unit={t(unitKey)} />
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
  // The basis line's band clause tracks whether heartRateBand is actually defined above, rather
  // than a single static string claiming a band that a thin or absent baseline never draws.
  const heartRateBasisKey = hrBaseline.isError
    // "No baseline yet" would be a claim about the person's history. A request that failed says
    // nothing about how much history there is.
    ? 'dashboard.heartRateRange.basisBaselineUnknown'
    : rawBaseline === null
      ? 'dashboard.heartRateRange.basisNoBaseline'
      : rawBaseline.thin
        ? 'dashboard.heartRateRange.basisThin'
        : 'dashboard.heartRateRange.basis'
  // Guarded like the tiles: emptyStateFor's own doc comment forbids a chart drawing an empty axis
  // when there is nothing to draw. No baseline argument here, since a thin baseline suppresses
  // only the band (above), not the whole card; the mean/min/max lines are a real chart on their
  // own even when the baseline behind the band is too thin to stand on.
  // All three requests, not only the mean: a card drawing three series has not settled until
  // the last of them has, and has failed if any of them did.
  const heartRateFailed = meanSeries.isError || minHrSeries.isError || maxHrSeries.isError
  const retryHeartRate = () => {
    void meanSeries.refetch()
    void minHrSeries.refetch()
    void maxHrSeries.refetch()
  }
  const heartRatePending = meanSeries.isPending || minHrSeries.isPending || maxHrSeries.isPending
  const heartRateEmpty: EmptyStateKind | null = heartRatePending ? null : emptyStateFor('heart_rate', meanHrPoints)

  // Daily steps heatmap: same dense-by-date treatment, so a day nothing reported still gets a
  // calendar cell (drawn as an absence dot) instead of silently compressing the grid.
  //
  // Not a MetricCard: the heatmap draws its own absence dots per day rather than trading the whole
  // chart for a text empty state, so MetricCard's emptyStateFor gate does not belong on this card
  // (adding it would blank a heatmap that has always drawn something). The worn count its basis
  // line needs is still the same wornOn arithmetic MetricCard runs internally, just kept here
  // because nothing else in this card can call through the component.
  const stepsPoints = metricGroups.pointsOf('steps')
  const stepsWorn = stepsPoints.filter((point) => wornOn('steps', point) === true).length
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
  // Nothing is stated while the request is in flight. heatmapDays is dense from the moment the
  // page mounts, so counting it before anything has settled reads "0 of 31 days worn", a specific
  // false claim rather than a vacuous one, and the card draws a placeholder instead.
  const stepsPending = metricGroups.queryFor('steps').isPending

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
    ? null : inWindow(localMinutesOf(lastNight.localDate, lastNight.startMs, lastNight.startOffsetMinutes))
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
      const { bed, wake } = withinSchedule(
        bedPoint ? inWindow(bedPoint.value) : null,
        wakePoint ? inWindow(wakePoint.value) : null,
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
        <Card span={3}>
          {tile('steps', 'dashboard.steps.label', 'dashboard.steps.basis', 'dashboard.steps.basisWorn',
            'dashboard.steps.chartLabel', 'dashboard.units.steps',
            (p) => groupNumber(values(p).reduce((a, b) => a + b, 0)), 'higher-is-better')}
          <Link to={deepLink('/activity', resolved)} className="card-link">
            {t('dashboard.steps.viewAll')}
          </Link>
        </Card>
        <Card span={3}>
          {tile('resting_heart_rate', 'dashboard.restingHr.label', 'dashboard.restingHr.basis',
            'dashboard.restingHr.basisWorn', 'dashboard.restingHr.chartLabel',
            'dashboard.units.beatsPerMinute',
            (p) => String(Math.round(mean(values(p)))), 'lower-is-better', t('dashboard.units.bpm'))}
          <Link to={deepLink('/recovery', resolved)} className="card-link">
            {t('dashboard.restingHr.viewAll')}
          </Link>
        </Card>
        <Card span={3}>
          {tile('sleep_asleep_minutes', 'dashboard.sleep.label', 'dashboard.sleep.basis',
            'dashboard.sleep.basisWorn', 'dashboard.sleep.chartLabel',
            'dashboard.units.minutesAsleep',
            (p) => formatDuration(mean(values(p))), 'higher-is-better')}
          {/* Plain, not deep linked: /sleep is still pinned to the July fixtures and ignores
              every parameter it is handed, so carrying the reader's period into that URL would
              promise a period the page does not honour. It gets its parameters back when the
              page can read them. */}
          <Link to="/sleep" className="card-link">
            {t('dashboard.sleep.viewAll')}
          </Link>
        </Card>
        <Card span={3}>
          {tile('heart_rate', 'dashboard.meanHr.label', 'dashboard.meanHr.basis',
            'dashboard.meanHr.basisWorn', 'dashboard.meanHr.chartLabel',
            'dashboard.units.beatsPerMinute',
            (p) => String(Math.round(mean(values(p)))), 'neutral', t('dashboard.units.bpm'))}
          <Link to={deepLink('/recovery', resolved)} className="card-link">
            {t('dashboard.meanHr.viewAll')}
          </Link>
        </Card>

        {/* basis withheld whenever there is no chart under it, the same way tile() returns an
            EmptyState in place of the whole StatTile including its basis: a band clause is a claim
            about what the chart below draws, and a pending request has drawn nothing yet. */}
        <Card span={8} label={t('dashboard.heartRateRange.label')}
          basis={heartRateFailed || heartRatePending || heartRateEmpty !== null
            ? undefined
            : t(heartRateBasisKey, { on: controls.to })}>
          {heartRateFailed ? <ErrorState onRetry={retryHeartRate} />
            : heartRatePending ? <Loading /> : heartRateEmpty !== null ? (
            <EmptyState title={t(`emptyState.${heartRateEmpty}.title`)} detail={t(`emptyState.${heartRateEmpty}.detail`)} />
          ) : (
            /* Empty until M3c. HeartRateRange has taken both props since D1 and fed them from
               fixtures; annotations and overrides are M3c's subject, and passing them empty here is
               a milestone boundary rather than an oversight. */
            <HeartRateRange days={heartRateDays} baseline={heartRateBand} annotations={EMPTY} excluded={EMPTY}
              label={t('dashboard.heartRateRange.chartLabel', { period })} />
          )}
        </Card>
        <Card span={4} label={t('dashboard.flaggedDays.label')}>
          <EmptyState title={t('dashboard.flaggedDays.emptyTitle')} detail={t('dashboard.flaggedDays.emptyDetail')} />
        </Card>

        {/* The date comes off the night being drawn, never off the range end: this card used to
            head an empty state with "last night, 2026-08-31", naming a night it was not drawing
            and had no row for, which is what the neighbour above withholds its basis to avoid. */}
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
        <Card span={5} label={t('dashboard.sleepSchedule.label')}
          basis={lastSeries.isError || lastSeries.isPending || scheduleNights.length === 0
            ? undefined
            : t('dashboard.sleepSchedule.basis', { count: drawnNights })}>
          {lastSeries.isError ? <ErrorState onRetry={() => void lastSeries.refetch()} />
            : lastSeries.isPending ? <Loading /> : scheduleNights.length === 0 ? (
            <EmptyState title={t('emptyState.no_data.title')} detail={t('emptyState.no_data.detail')} />
          ) : (
            <SleepSchedule nights={scheduleNights} showNaps={false} label={t('common.bedWakeChartLabel', { period })} />
          )}
        </Card>

        <Card span={8} label={t('dashboard.dailySteps.label')}
          basis={sumSeries.isError || stepsPending ? undefined : t('dashboard.dailySteps.basis', {
            worn: stepsWorn, total: rangeDates.length, maxSteps: groupNumber(maxSteps),
          })}>
          {sumSeries.isError ? <ErrorState onRetry={() => void sumSeries.refetch()} />
            : stepsPending ? <Loading /> : (
            <ActivityHeatmap days={heatmapDays} max={maxSteps} label={t('dashboard.dailySteps.chartLabel', { period })} />
          )}
        </Card>
        <Card span={4} label={t('dashboard.recovery.label')}>
          <EmptyState title={t('dashboard.recovery.emptyTitle')}
            detail={t('dashboard.recovery.emptyDetail')} />
        </Card>

        <Card span={12} label={t('dashboard.anomalies.label')}>
          <EmptyState title={t('dashboard.anomalies.emptyTitle')} detail={t('dashboard.anomalies.emptyDetail')} />
        </Card>
      </div>
    </>
  )
}
