import type { UseQueryResult } from '@tanstack/react-query'
import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { StatTile } from '../components/StatTile.js'
import { EmptyState } from '../components/EmptyState.js'
import { ControlRow } from '../components/ControlRow.js'
import { Sparkline } from '../charts/Sparkline.js'
import { HeartRateRange } from '../charts/HeartRateRange.js'
import { Hypnogram } from '../charts/Hypnogram.js'
import { SleepSchedule, AXIS_MIN, AXIS_MAX } from '../charts/SleepSchedule.js'
import { ActivityHeatmap } from '../charts/ActivityHeatmap.js'
import { usePageControls } from '../controls/usePageControls.js'
import { deepLink } from '../controls/deepLink.js'
import { Link } from '../router.js'
import { useSession } from '../auth/session.js'
import { useSeries } from '../data/useSeries.js'
import type { MetricSeries, SeriesPoint } from '../data/useSeries.js'
import { useBaseline } from '../data/useBaseline.js'
import { useNights } from '../data/useNights.js'
import type { Night } from '../data/useNights.js'
import { useSyncStatus } from '../data/useSyncStatus.js'
import { emptyStateFor } from '../data/emptyState.js'
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
// apps/web does not depend on @haelan/core (BackfillStep.tsx documents the same boundary for the
// intraday cap): that package's one export pulls in better-sqlite3 and argon2, native modules a
// browser bundle cannot carry. So this mapping is written out here rather than imported, which
// duplicates a fact the catalogue also states; it is confined to this one place instead of spread
// across every card, and it is exactly the id-to-agg pairing above, nothing wider.
const SUM_METRICS = ['steps', 'sleep_asleep_minutes'] as const
const LAST_METRICS = ['resting_heart_rate', 'sleep_bedtime_minutes', 'sleep_waketime_minutes'] as const
const MEAN_METRICS = ['heart_rate'] as const
const MIN_METRICS = ['heart_rate'] as const
const MAX_METRICS = ['heart_rate'] as const

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

// The device names offered in the control row's source selector, read off data this page already
// fetches rather than a route of its own: sourceMix (merge.ts's encodeMix) records which devices
// contributed to each merged row, so every source this person has shows up in it somewhere as
// long as at least one point on the page is a merged row.
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

// Mirrors packages/core/src/derive/localDay.ts's localMinutesOf, the one piece of that file the
// sleep charts need: minutes from the local midnight of `localDate`, negative before it. Not
// imported for the same reason the agg map above is not: apps/web cannot depend on @haelan/core.
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
  const range = { from: controls.from, to: controls.to, source: controls.source }
  const period = `${controls.from} ${t('common.to')} ${controls.to}`

  // Fixed groups, not derived from a response: this hook runs the same five times in the same
  // order on every render regardless of what any of them returns.
  const sumSeries = useSeries([...SUM_METRICS], range, 'sum')
  const lastSeries = useSeries([...LAST_METRICS], range, 'last')
  const meanSeries = useSeries([...MEAN_METRICS], range, 'mean')
  const minHrSeries = useSeries([...MIN_METRICS], range, 'min')
  const maxHrSeries = useSeries([...MAX_METRICS], range, 'max')
  // 'mean' explicitly: useBaseline defaults to 'sum', which heart_rate's catalogue entry does not
  // list, and the default would 400 the request (ConfigError, requireSource/requireMetricAndAgg)
  // the same way it would for /series.
  const hrBaseline = useBaseline('heart_rate', controls.anchor, controls.source, 'mean')
  const nights = useNights(range)
  const syncStatus = useSyncStatus()

  // Minutes ago, not a timestamp, because syncedAgo's own message reads "Synced N min ago":
  // nothing synced yet reads as 0, the same value this literally was before Task 12 wired it,
  // rather than a special case this card has no copy for.
  const syncedMinutesAgo = syncStatus.data?.lastFinishedAtMs != null
    ? Math.max(0, Math.round((Date.now() - syncStatus.data.lastFinishedAtMs) / 60_000))
    : 0
  const sources = distinctSources([sumSeries, lastSeries, meanSeries, minHrSeries, maxHrSeries])
  const personId = session.data?.personId
  const exportPath = personId !== undefined ? exportPathFor(personId, range) : undefined

  const groups = [
    { metrics: SUM_METRICS as readonly string[], query: sumSeries },
    { metrics: LAST_METRICS as readonly string[], query: lastSeries },
    { metrics: MEAN_METRICS as readonly string[], query: meanSeries },
  ]
  const queryFor = (metric: string) => groups.find((g) => g.metrics.includes(metric))!.query

  // The active language, not a pinned locale: a bilingual app whose numbers only ever group like
  // English is not actually speaking Dutch when it renders Dutch.
  const groupNumber = (value: number) => value.toLocaleString(i18n.language)

  const pointsOf = (metric: string): SeriesPoint[] => queryFor(metric).data?.[metric]?.points ?? []

  // Coverage is per point and comes straight off the envelope, so the basis line states what the
  // number actually rests on rather than asserting a figure nobody computed.
  const basisOf = (points: SeriesPoint[]) => {
    const worn = points.filter((p) => p.coverage !== null && p.coverage > 0).length
    return { worn, total: points.length, unworn: points.length - worn }
  }

  const tile = (
    metric: string, labelKey: string, basisKey: string, chartLabelKey: string, unitKey: string,
    format: (points: SeriesPoint[]) => string,
    direction: 'higher-is-better' | 'lower-is-better' | 'neutral',
    unit?: string,
  ) => {
    const points = pointsOf(metric)
    const empty: EmptyStateKind | null = queryFor(metric).isPending ? null : emptyStateFor(points)
    if (empty !== null) {
      return <EmptyState title={t(`emptyState.${empty}.title`)} detail={t(`emptyState.${empty}.detail`)} />
    }
    // trend() itself answers "no delta" (undefined) for a window with too few points to compare,
    // which covers both the pending fetch (points still empty) and the day range (exactly one
    // point), so there is nothing left for this call site to guard against.
    return (
      <StatTile label={t(labelKey)} value={format(points)} unit={unit}
        basis={t(basisKey, basisOf(points))}
        delta={trend(t, values(points), direction)}>
        <Sparkline values={points.map((p) => p.value)} labels={points.map((p) => p.localDate)}
          label={t(chartLabelKey, { period })} unit={t(unitKey)} />
      </StatTile>
    )
  }

  // Heart rate range: one day per date in range, min/mean/max looked up by localDate rather than
  // zipped by array position, because each of the three requests can be silent on a different day
  // (a source that only samples during waking hours never reports a night-time minimum) and the
  // three arrays are not guaranteed to line up index for index.
  const meanHrByDate = new Map(pointsOf('heart_rate').map((p) => [p.localDate, p]))
  const minHrByDate = new Map((minHrSeries.data?.heart_rate?.points ?? []).map((p) => [p.localDate, p]))
  const maxHrByDate = new Map((maxHrSeries.data?.heart_rate?.points ?? []).map((p) => [p.localDate, p]))
  const heartRateDays = datesBetween(controls.from, controls.to).map((date) => {
    const meanPoint = meanHrByDate.get(date)
    return {
      date,
      steps: null, sleepMinutes: null,
      hrMin: minHrByDate.get(date)?.value ?? null,
      hrMean: meanPoint?.value ?? null,
      hrMax: maxHrByDate.get(date)?.value ?? null,
      // true (not worn) when there is no point at all: a missing point already reads as "no
      // reading" through the null cells above, and adding "not worn" on top of that would assert
      // a specific reason for the gap this data does not support. false only when a point exists
      // and its own coverage says so.
      worn: meanPoint === undefined || (meanPoint.coverage !== null && meanPoint.coverage > 0),
    }
  })
  const rawBaseline = hrBaseline.data?.baseline ?? null
  // Thin stays undefined, not a band drawn thin: a band computed from three days looks exactly as
  // authoritative as one computed from thirty, and thin is the reader's only signal that it is
  // not.
  const heartRateBand = rawBaseline !== null && !rawBaseline.thin
    ? { low: rawBaseline.center - rawBaseline.spread, high: rawBaseline.center + rawBaseline.spread }
    : undefined
  // The basis line's band clause tracks whether heartRateBand is actually defined above, rather
  // than a single static string claiming a band that a thin or absent baseline never draws.
  const heartRateBasisKey = rawBaseline === null
    ? 'dashboard.heartRateRange.basisNoBaseline'
    : rawBaseline.thin
      ? 'dashboard.heartRateRange.basisThin'
      : 'dashboard.heartRateRange.basis'
  // Guarded like the tiles: emptyStateFor's own doc comment forbids a chart drawing an empty axis
  // when there is nothing to draw. No baseline argument here, since a thin baseline suppresses
  // only the band (above), not the whole card; the mean/min/max lines are a real chart on their
  // own even when the baseline behind the band is too thin to stand on.
  const heartRateEmpty: EmptyStateKind | null = meanSeries.isPending ? null : emptyStateFor(pointsOf('heart_rate'))

  // Daily steps heatmap: same dense-by-date treatment, so a day nothing reported still gets a
  // calendar cell (drawn as an absence dot) instead of silently compressing the grid.
  const stepsPoints = pointsOf('steps')
  const stepsByDate = new Map(stepsPoints.map((p) => [p.localDate, p]))
  const heatmapDays = datesBetween(controls.from, controls.to).map((date) => {
    const point = stepsByDate.get(date)
    return {
      date, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null,
      steps: point?.value ?? null,
      worn: point !== undefined && point.coverage !== null && point.coverage > 0,
    }
  })
  const maxSteps = Math.max(0, ...values(stepsPoints))
  // Worn against every calendar day in range, not against however many points happened to
  // arrive: basisOf(stepsPoints) would read the same "N of N" whether N days reported or the
  // whole month did, since a day with no point is simply absent from stepsPoints rather than
  // present with a false reading. heatmapDays is already dense over the whole range, so counting
  // worn there states the coverage the grid actually draws.
  //
  // Pending-gated the way tile() and heartRateEmpty are, but on the numbers rather than on
  // swapping in a whole empty state: heatmapDays is dense from the moment the page mounts, before
  // any request has settled, so its own count would otherwise read "0 of 31 days worn" while
  // nothing has actually been checked yet, a stronger and more specific false claim than the "0
  // of 0" the sparse stat tiles harmlessly show in the same pending moment. Falling back to that
  // same vacuous 0 of 0 here keeps this card from asserting a total before it has one.
  const heatmapWorn = heatmapDays.filter((d) => d.worn).length
  const heatmapBasisStats = queryFor('steps').isPending
    ? { worn: 0, total: 0, unworn: 0 }
    : { worn: heatmapWorn, total: heatmapDays.length, unworn: heatmapDays.length - heatmapWorn }

  // Sleep stages (hypnogram): the most recent night in range, one per source collapsed to one per
  // date. Pending-tolerant the same way tile() is, rather than flashing "no data" the instant
  // between mount and the request resolving.
  const collapsedNights = oneNightPerDate(nights.data?.items ?? [])
  const lastNight = collapsedNights.at(-1) ?? null
  const nightEmpty: EmptyStateKind | null = nights.isPending ? null : (lastNight === null ? 'no_data' : null)
  const hypnogramSegments = lastNight === null ? [] : lastNight.segments
    .map((s) => ({
      stage: stageOf(s.stage),
      from: Math.round((s.startMs - lastNight.startMs) / 60_000),
      to: Math.round((s.endMs - lastNight.startMs) / 60_000),
    }))
    .filter((s): s is { stage: Stage, from: number, to: number } => s.stage !== null)
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
  const bedtimeByDate = new Map(pointsOf('sleep_bedtime_minutes').map((p) => [p.localDate, p]))
  const waketimeByDate = new Map(pointsOf('sleep_waketime_minutes').map((p) => [p.localDate, p]))
  const scheduleDates = [...new Set([...bedtimeByDate.keys(), ...waketimeByDate.keys()])].sort()
  const scheduleNights = scheduleDates.map((date) => {
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
      naps: [] as number[],
    }
  })
  const scheduleEmpty: EmptyStateKind | null = lastSeries.isPending ? null : (scheduleDates.length === 0 ? 'no_data' : null)

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('dashboard.title')}</h1>
      <ControlRow controls={controls} sources={sources} syncedMinutesAgo={syncedMinutesAgo} exportPath={exportPath} />
      <div className="grid">
        <Card span={3}>
          {tile('steps', 'dashboard.steps.label', 'dashboard.steps.basis', 'dashboard.steps.chartLabel', 'dashboard.units.steps',
            (p) => groupNumber(values(p).reduce((a, b) => a + b, 0)), 'higher-is-better')}
          <Link to={deepLink('/activity', controls)} className="card-link">
            {t('dashboard.steps.viewAll')}
          </Link>
        </Card>
        <Card span={3}>
          {tile('resting_heart_rate', 'dashboard.restingHr.label', 'dashboard.restingHr.basis', 'dashboard.restingHr.chartLabel',
            'dashboard.units.beatsPerMinute',
            (p) => String(Math.round(mean(values(p)))), 'lower-is-better', t('dashboard.units.bpm'))}
          <Link to={deepLink('/recovery', controls)} className="card-link">
            {t('dashboard.restingHr.viewAll')}
          </Link>
        </Card>
        <Card span={3}>
          {tile('sleep_asleep_minutes', 'dashboard.sleep.label', 'dashboard.sleep.basis', 'dashboard.sleep.chartLabel',
            'dashboard.units.minutesAsleep',
            (p) => formatDuration(mean(values(p))), 'higher-is-better')}
          <Link to={deepLink('/sleep', controls)} className="card-link">
            {t('dashboard.sleep.viewAll')}
          </Link>
        </Card>
        <Card span={3}>
          {tile('heart_rate', 'dashboard.meanHr.label', 'dashboard.meanHr.basis', 'dashboard.meanHr.chartLabel',
            'dashboard.units.beatsPerMinute',
            (p) => String(Math.round(mean(values(p)))), 'neutral', t('dashboard.units.bpm'))}
          <Link to={deepLink('/recovery', controls)} className="card-link">
            {t('dashboard.meanHr.viewAll')}
          </Link>
        </Card>

        {/* basis withheld when heartRateEmpty is set, the same way tile() returns EmptyState in
            place of the whole StatTile including its basis: a band clause is a claim about what
            the chart below draws, and there is no chart below when this reads "No data yet". */}
        <Card span={8} label={t('dashboard.heartRateRange.label')}
          basis={heartRateEmpty !== null ? undefined : t(heartRateBasisKey)}>
          {heartRateEmpty !== null ? (
            <EmptyState title={t(`emptyState.${heartRateEmpty}.title`)} detail={t(`emptyState.${heartRateEmpty}.detail`)} />
          ) : (
            /* Empty until M3c. HeartRateRange has taken both props since D1 and fed them from
               fixtures; annotations and overrides are M3c's subject, and passing them empty here is
               a milestone boundary rather than an oversight. */
            <HeartRateRange days={heartRateDays} baseline={heartRateBand} annotations={[]} excluded={[]}
              label={t('dashboard.heartRateRange.chartLabel', { period })} />
          )}
        </Card>
        <Card span={4} label={t('dashboard.flaggedDays.label')}>
          <EmptyState title={t('dashboard.flaggedDays.emptyTitle')} detail={t('dashboard.flaggedDays.emptyDetail')} />
        </Card>

        <Card span={7} label={t('dashboard.sleepStages.label')}
          basis={t('dashboard.sleepStages.basis', { date: lastNight?.localDate ?? controls.to })}>
          {nightEmpty !== null ? (
            <EmptyState title={t(`emptyState.${nightEmpty}.title`)} detail={t(`emptyState.${nightEmpty}.detail`)} />
          ) : (
            <Hypnogram segments={hypnogramSegments} startLabel={startLabel}
              label={t('dashboard.sleepStages.chartLabel', { date: lastNight?.localDate ?? controls.to })} />
          )}
        </Card>
        <Card span={5} label={t('dashboard.sleepSchedule.label')}
          basis={t('dashboard.sleepSchedule.basis', { nights: scheduleDates.length })}>
          {scheduleEmpty !== null ? (
            <EmptyState title={t(`emptyState.${scheduleEmpty}.title`)} detail={t(`emptyState.${scheduleEmpty}.detail`)} />
          ) : (
            <SleepSchedule nights={scheduleNights} showNaps={false} label={t('common.bedWakeChartLabel', { period })} />
          )}
        </Card>

        <Card span={8} label={t('dashboard.dailySteps.label')}
          basis={t('dashboard.dailySteps.basis', {
            ...heatmapBasisStats, maxSteps: groupNumber(maxSteps),
          })}>
          <ActivityHeatmap days={heatmapDays} max={maxSteps} label={t('dashboard.dailySteps.chartLabel', { period })} />
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
