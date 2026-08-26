import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { StatTile } from '../components/StatTile.js'
import { EmptyState } from '../components/EmptyState.js'
import { ControlRow } from '../components/ControlRow.js'
import { Sparkline } from '../charts/Sparkline.js'
import { HeartRateRange } from '../charts/HeartRateRange.js'
import { Hypnogram } from '../charts/Hypnogram.js'
import { SleepSchedule } from '../charts/SleepSchedule.js'
import { ActivityHeatmap } from '../charts/ActivityHeatmap.js'
import { usePageControls } from '../controls/usePageControls.js'
import { useSeries } from '../data/useSeries.js'
import type { SeriesPoint } from '../data/useSeries.js'
import { useBaseline } from '../data/useBaseline.js'
import { useNights } from '../data/useNights.js'
import { emptyStateFor } from '../data/emptyState.js'
import type { EmptyStateKind } from '../data/emptyState.js'
import { formatClock, formatDuration, trend } from '../format.js'

// /series takes a repeated metric parameter but exactly one `agg` for the whole call
// (requireMetricAndAgg in packages/core/src/query/personQuery.ts checks every metric against
// that same value), and a metric only has rows under the aggs its own catalogue entry lists. So
// "one request per card" is not achievable here: the six card metrics below need four different
// aggs, and asking heart_rate or resting_heart_rate for 'sum' (or steps for 'last') 500s the whole
// request, not just that metric. What is achievable, and what actually prevents six separate
// round trips, is one request per distinct agg, with every metric that shares an agg riding along.
//
// Checked against packages/core/src/derive/metrics.ts rather than against the card labels:
// 'sleep_minutes' is not a metric the catalogue defines, so this uses 'sleep_asleep_minutes', the
// real id for the summed minutes a night's sleep segments cover. 'steps', 'resting_heart_rate' and
// 'heart_rate' are real ids as written. Per the catalogue: steps and sleep_asleep_minutes are
// TOTAL metrics (aggs: ['sum']); resting_heart_rate is a once-a-day reading (aggs: ['last'], no
// 'mean' to average since there is only ever one row a day to begin with); heart_rate is intraday
// (aggs: ['min', 'mean', 'max', 'p50', 'count']). The mean-HR tile asks for 'mean', which is what
// its own label ("Mean heart rate") and basis line ("mean, ... days") claim to show. The heart
// rate range card draws all three of min, mean and max, which its own basis line has always
// claimed ("daily minimum, mean and maximum"): a chart naming three series while drawing one,
// because a nearby test happened to count requests, would be the same kind of untrue basis line
// this project refuses to draw for an empty state, so 'min' and 'max' are two further requests
// rather than two blank channels.
//
// apps/web does not depend on @haelan/core (BackfillStep.tsx documents the same boundary for the
// intraday cap): that package's one export pulls in better-sqlite3 and argon2, native modules a
// browser bundle cannot carry. So this mapping is written out here rather than imported, which
// duplicates a fact the catalogue also states; it is confined to this one place instead of spread
// across every card, and it is exactly the id-to-agg pairing above, nothing wider.
const SUM_METRICS = ['steps', 'sleep_asleep_minutes'] as const
const LAST_METRICS = ['resting_heart_rate'] as const
const MEAN_METRICS = ['heart_rate'] as const
const MIN_METRICS = ['heart_rate'] as const
const MAX_METRICS = ['heart_rate'] as const

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

// Mirrors packages/core/src/derive/localDay.ts's localMinutesOf, the one piece of that file the
// sleep charts need: minutes from the local midnight of `localDate`, negative before it. Not
// imported for the same reason the agg map above is not: apps/web cannot depend on @haelan/core.
function localMinutesOf(localDate: string, utcMs: number, offsetMinutes: number): number {
  const wall = utcMs + offsetMinutes * 60_000
  return Math.round((wall - Date.parse(`${localDate}T00:00:00Z`)) / 60_000)
}

// Hypnogram's own Stage type lives in the July fixtures module, which this page cannot import
// (see the "does not import the fixtures" test): a local, structurally identical union avoids
// that import for the one type this file needs from it.
type Stage = 'deep' | 'light' | 'rem' | 'awake'

// packages/core/src/derive/sleep.ts's ASLEEP_STAGES and AWAKE_STAGE are the only recognised
// values a segment's stage carries ('DEEP', 'LIGHT', 'REM', 'AWAKE'); anything else is a
// vocabulary neither this reader nor the derive layer recognises. Falling back to 'light' rather
// than throwing matches Hypnogram's own renderItem, which already treats an unmapped lane the
// same way.
function stageOf(raw: string): Stage {
  const known: Record<string, Stage> = { DEEP: 'deep', LIGHT: 'light', REM: 'rem', AWAKE: 'awake' }
  return known[raw] ?? 'light'
}

export function Dashboard() {
  const { t, i18n } = useTranslation()
  const controls = usePageControls()
  const range = { from: controls.from, to: controls.to, source: controls.source }
  const period = `${controls.from} to ${controls.to}`

  // Fixed groups, not derived from a response: this hook runs the same five times in the same
  // order on every render regardless of what any of them returns.
  const sumSeries = useSeries([...SUM_METRICS], range, 'sum')
  const lastSeries = useSeries([...LAST_METRICS], range, 'last')
  const meanSeries = useSeries([...MEAN_METRICS], range, 'mean')
  const minHrSeries = useSeries([...MIN_METRICS], range, 'min')
  const maxHrSeries = useSeries([...MAX_METRICS], range, 'max')
  // 'mean' explicitly: useBaseline defaults to 'sum', which heart_rate's catalogue entry does not
  // list, and the default would 500 the request the same way it would for /series.
  const hrBaseline = useBaseline('heart_rate', controls.anchor, controls.source, 'mean')
  const nights = useNights(range)

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
    metric: string, labelKey: string, chartLabelKey: string, unitKey: string,
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
    //
    // cardKey rather than labelKey.replace('.label', ''): catalogue-usage.test.ts can only see a
    // dynamically built key through its own `` `prefix.${` `` heuristic, and a string built by
    // .replace() has no such literal prefix in source for it to find, which is why
    // dashboard.steps.basis and its three siblings read as orphaned without this.
    const cardKey = labelKey.split('.')[1]
    return (
      <StatTile label={t(labelKey)} value={format(points)} unit={unit}
        basis={t(`dashboard.${cardKey}.basis`, basisOf(points))}
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
      worn: meanPoint !== undefined && meanPoint.coverage !== null && meanPoint.coverage > 0,
    }
  })
  const rawBaseline = hrBaseline.data?.baseline ?? null
  // Thin stays undefined, not a band drawn thin: a band computed from three days looks exactly as
  // authoritative as one computed from thirty, and thin is the reader's only signal that it is
  // not.
  const heartRateBand = rawBaseline !== null && !rawBaseline.thin
    ? { low: rawBaseline.center - rawBaseline.spread, high: rawBaseline.center + rawBaseline.spread }
    : undefined

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

  // Sleep nights: the most recent one in range for the hypnogram, every one for the schedule.
  // Nights is pending-tolerant the same way tile() is, rather than flashing "no data" the instant
  // between mount and the request resolving.
  const nightItems = nights.data?.items ?? []
  const lastNight = nightItems.at(-1) ?? null
  const nightEmpty: EmptyStateKind | null = nights.isPending ? null : (lastNight === null ? 'no_data' : null)
  const hypnogramSegments = lastNight === null ? [] : lastNight.segments.map((s) => ({
    stage: stageOf(s.stage),
    from: Math.round((s.startMs - lastNight.startMs) / 60_000),
    to: Math.round((s.endMs - lastNight.startMs) / 60_000),
  }))
  const lastNightBedMinutes = lastNight === null
    ? null : localMinutesOf(lastNight.localDate, lastNight.startMs, lastNight.startOffsetMinutes)
  const startLabel = lastNightBedMinutes !== null
    ? t('common.bedLabel', { time: formatClock(lastNightBedMinutes) })
    : t('common.bedTimeNotRecorded')
  // /sleep/nights groups every sleep session sharing a date and source into one entry (see
  // packages/core/src/query/sleepNights.ts), naps included, so there is no separate nap list left
  // to plot here the way the fixture's schedule carried one; leaving it empty is honest about
  // what this route actually distinguishes rather than a loss this call site introduced.
  const scheduleNights = nightItems.map((n) => ({
    date: n.localDate,
    bed: localMinutesOf(n.localDate, n.startMs, n.startOffsetMinutes),
    wake: localMinutesOf(n.localDate, n.endMs, n.endOffsetMinutes),
    naps: [] as number[],
  }))

  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('dashboard.title')}</h1>
      <ControlRow controls={controls} sources={[]} syncedMinutesAgo={0} />
      <div className="grid">
        <Card span={3}>
          {tile('steps', 'dashboard.steps.label', 'dashboard.steps.chartLabel', 'dashboard.units.steps',
            (p) => groupNumber(values(p).reduce((a, b) => a + b, 0)), 'higher-is-better')}
        </Card>
        <Card span={3}>
          {tile('resting_heart_rate', 'dashboard.restingHr.label', 'dashboard.restingHr.chartLabel',
            'dashboard.units.beatsPerMinute',
            (p) => String(Math.round(mean(values(p)))), 'lower-is-better', t('dashboard.units.bpm'))}
        </Card>
        <Card span={3}>
          {tile('sleep_asleep_minutes', 'dashboard.sleep.label', 'dashboard.sleep.chartLabel',
            'dashboard.units.minutesAsleep',
            (p) => formatDuration(mean(values(p))), 'higher-is-better')}
        </Card>
        <Card span={3}>
          {tile('heart_rate', 'dashboard.meanHr.label', 'dashboard.meanHr.chartLabel',
            'dashboard.units.beatsPerMinute',
            (p) => String(Math.round(mean(values(p)))), 'neutral', t('dashboard.units.bpm'))}
        </Card>

        <Card span={8} label={t('dashboard.heartRateRange.label')}
          basis={t('dashboard.heartRateRange.basis')}>
          {/* Empty until M3c. HeartRateRange has taken both props since D1 and fed them from
              fixtures; annotations and overrides are M3c's subject, and passing them empty here is
              a milestone boundary rather than an oversight. */}
          <HeartRateRange days={heartRateDays} baseline={heartRateBand} annotations={[]} excluded={[]}
            label={t('dashboard.heartRateRange.chartLabel', { period })} />
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
          basis={t('common.bedWakeBasis', { nights: nightItems.length })}>
          <SleepSchedule nights={scheduleNights} label={t('common.bedWakeChartLabel', { period })} />
        </Card>

        <Card span={8} label={t('dashboard.dailySteps.label')}
          basis={t('dashboard.dailySteps.basis', {
            ...basisOf(stepsPoints), maxSteps: groupNumber(maxSteps),
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
