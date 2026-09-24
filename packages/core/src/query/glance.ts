import { METRICS } from '../derive/metrics.ts'
import { shiftLocalDate } from '../derive/localDay.ts'
import type { PersonQuery, DailyPoint } from './personQuery.ts'
import type { IntradayPoint } from './intraday.ts'
import { baselineWindow, baselineOf } from './baseline.ts'
import type { Baseline } from './baseline.ts'
import { oneNightPerDate } from '../api/nights.ts'
import type { NightSegment } from './sleepNights.ts'
import { recoveryIndexSeries, bandOf } from '../api/recoveryIndex.ts'
import type { RecoveryBand } from '../api/recoveryIndex.ts'
import { readRecoveryInput } from './recoveryInput.ts'
import type { WorkoutSession } from './sessions.ts'

/**
 * The glance: last night, today's recovery and today so far, as one person bound read (M9a).
 *
 * The payload is the contract, not a page. The web dashboard (M9b) and the native app (M12)
 * render it, so anything either client would otherwise compute - a baseline, which night counts
 * as last night, whether a source has gone quiet - is decided here once. Everything is computed
 * on read from existing rows; nothing is stored, so no install rebuilds on upgrade.
 *
 * Every figure says what it is current to in two ways, because they answer different questions.
 * `asOfDate` is the day the value belongs to, which a once-a-day reading (HRV, resting heart
 * rate) always has. `asOfMs` is the instant of the last reading behind it, which only a figure
 * built from samples (steps, today's heart rate) or from a night (its end) can name. Neither is
 * ever `daily.updated_at_ms`: that is when derivation ran, and after a rebuild it would call a
 * week-old number fresh.
 */

/** A source feeding a figure that has gone quiet by its own cadence (M6a's rule), with its name. */
export interface GlanceStaleSource { sourceId: string, name: string, lastReportedDate: string, medianGapDays: number | null }

/** A figure's baseline as the band a client draws: centre, and one spread either side. */
export interface GlanceBaseline { center: number, low: number, high: number, thin: boolean }

export interface GlanceStripDay { localDate: string, value: number | null }

export interface GlanceFigure {
  metric: string
  value: number | null
  unit: string
  baseline: GlanceBaseline | null
  /** The local date `value` belongs to; null when there is no value. */
  asOfDate: string | null
  /** The instant of the last reading behind `value`, where one exists; never a write time. */
  asOfMs: number | null
  /** True while the day `value` belongs to is still running. */
  partial: boolean
  staleSources: GlanceStaleSource[]
  /** Seven entries, oldest first, ending on the figure's own date. */
  strip: GlanceStripDay[]
  /** Where `value` sits against `baseline`; null when there is nothing honest to say. */
  standing: GlanceStanding | null
}

/** Where a figure sits against its usual; the web and the phone both colour by it, so it is decided here once (M9d spec). */
export type GlanceStanding = 'within' | 'above' | 'below'

/**
 * Null when there is nothing honest to say: no value, no band, a band too thin to stand on, or a day
 * still running, which is never judged against a whole day's usual (a partial figure says "so far").
 */
export function standingOf(value: number | null, baseline: GlanceBaseline | null, partial: boolean): GlanceStanding | null {
  if (value === null || baseline === null || baseline.thin || partial) return null
  if (value < baseline.low) return 'below'
  if (value > baseline.high) return 'above'
  return 'within'
}

/** What every section reads: the person's query, their today, now, and who has gone quiet. */
export interface GlanceContext {
  q: PersonQuery
  today: string
  nowMs: number
  /** Stale sources by id, from sourceActivity, judged against `today`. */
  stale: ReadonlyMap<string, { lastReportedDate: string, medianGapDays: number | null }>
  nameOf: (sourceId: string) => string
}

const STRIP_DAYS = 7

export function contextFor(
  q: PersonQuery, input: { today: string, nowMs: number, nameOf: (id: string) => string },
): GlanceContext {
  const stale = new Map<string, { lastReportedDate: string, medianGapDays: number | null }>()
  for (const activity of q.sourceActivity({ today: input.today })) {
    if (activity.status !== 'stale' || activity.lastReportedDate === null) continue
    // A source whose data kept arriving under another id (a renamed watch) is not missing from
    // any figure, so no figure warns about it. See sourceActivity.ts.
    if (activity.continuedElsewhere) continue
    stale.set(activity.sourceId, { lastReportedDate: activity.lastReportedDate, medianGapDays: activity.medianGapDays })
  }
  return { q, today: input.today, nowMs: input.nowMs, stale, nameOf: input.nameOf }
}

/** The sources a merged row names in its mix, or the row's own source when it is a device row. */
function sourcesOf(point: DailyPoint): string[] {
  if (point.sourceMix === null) return point.source === 'merged' || point.source === 'provider' ? [] : [point.source]
  try {
    const parsed: unknown = JSON.parse(point.sourceMix)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => (entry !== null && typeof entry === 'object' ? (entry as { source?: unknown }).source : undefined))
      .filter((source): source is string => typeof source === 'string')
  } catch {
    // A malformed mix is a temporarily incomplete source list, never a failed payload.
    return []
  }
}

export function staleFeeding(ctx: GlanceContext, sourceIds: Iterable<string>): GlanceStaleSource[] {
  const out: GlanceStaleSource[] = []
  for (const sourceId of new Set(sourceIds)) {
    const stale = ctx.stale.get(sourceId)
    if (stale === undefined) continue
    out.push({ sourceId, name: ctx.nameOf(sourceId), lastReportedDate: stale.lastReportedDate, medianGapDays: stale.medianGapDays })
  }
  // Sorted by the name a person reads, so the list is stable across requests rather than in
  // whatever order the rows happened to name the sources, which would also move the ETag.
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * How far back a figure looks for the sources that fed it: its baseline window and its own date,
 * the 60 days before `on` through `on`.
 *
 * Not the seven-day strip. A source only counts as stale after STALE_FLOOR_DAYS (14) of silence
 * (api/sourceCadence.ts), and a merged row's sourceMix names only the sources that reported that
 * day, so a source quiet long enough to be stale is by definition absent from the last week's
 * rows. Looking back over the baseline instead asks the question a person means: did something
 * that used to feed this number stop?
 */
function lookBack(on: string): { from: string, to: string } {
  return { from: baselineWindow(on).from, to: on }
}

/** A metric's daily points over its look-back, the one read both a figure and its stale sources draw on. */
function lookBackPoints(ctx: GlanceContext, metric: string, agg: string, on: string): DailyPoint[] {
  return ctx.q.series({ metric, agg, ...lookBack(on) }).points
}

export function stripDates(on: string): string[] {
  return Array.from({ length: STRIP_DAYS }, (_, i) => shiftLocalDate(on, i - (STRIP_DAYS - 1)))
}

/** One place turns a query's baseline into the band a client draws, so the two figures below cannot drift apart on the shape. */
function toGlanceBaseline(baseline: Baseline | null): GlanceBaseline | null {
  return baseline === null ? null : {
    center: baseline.center, low: baseline.center - baseline.spread, high: baseline.center + baseline.spread, thin: baseline.thin,
  }
}

export function dailyFigure(
  ctx: GlanceContext, o: { metric: string, agg: string, on: string, partial: boolean, asOfMs: number | null },
): GlanceFigure {
  const dates = stripDates(o.on)
  const points = lookBackPoints(ctx, o.metric, o.agg, o.on)
  const byDate = new Map(points.map((point) => [point.localDate, point]))
  const onDay = byDate.get(o.on)
  const baseline = ctx.q.baseline({ metric: o.metric, agg: o.agg, on: o.on })
  const band = toGlanceBaseline(baseline)
  return {
    metric: o.metric,
    value: onDay?.value ?? null,
    unit: METRICS[o.metric]?.unit ?? '',
    baseline: band,
    asOfDate: onDay === undefined ? null : o.on,
    asOfMs: onDay === undefined ? null : o.asOfMs,
    partial: o.partial,
    staleSources: staleFeeding(ctx, points.flatMap(sourcesOf)),
    strip: dates.map((localDate) => ({ localDate, value: byDate.get(localDate)?.value ?? null })),
    standing: standingOf(onDay?.value ?? null, band, o.partial),
  }
}

export interface GlanceHeartRate { points: IntradayPoint[], asOfMs: number | null, staleSources: GlanceStaleSource[] }
export interface GlanceDay {
  steps: GlanceFigure
  activeMinutes: GlanceFigure
  heartRate: GlanceHeartRate
  /**
   * Today's workouts, oldest first, one per event however many sources recorded it: the same
   * merged objects the Activity list answers (mergedWorkouts.ts), so a row here and a row there
   * open the same page. Excluded ones included and marked, as the list marks them.
   */
  workouts: WorkoutSession[]
}

export const ACTIVE_MINUTE_METRICS: readonly string[] = ['active_minutes_light', 'active_minutes_moderate', 'active_minutes_vigorous']

// Heart rate thinned to a five minute budget over a day, which is what a card-sized trace can
// draw; the reading's own resolution stays on the Recovery page's intraday chart.
const HEART_RATE_POINTS = 288

/** The instant of the last sample of any of `metrics` on `today`, or null when there is none. */
function lastSampleMs(ctx: GlanceContext, metrics: readonly string[]): number | null {
  let latest: number | null = null
  for (const metric of metrics) {
    for (const point of ctx.q.intraday({ metric, localDate: ctx.today }).points) {
      if (latest === null || point.utcMs > latest) latest = point.utcMs
    }
  }
  return latest
}

/**
 * Active minutes as one figure: the three activity levels summed per day, which is what a person
 * means by "active minutes today". The baseline is taken over the summed days rather than built
 * from three baselines, because three spreads do not add.
 */
function activeMinutesFigure(ctx: GlanceContext): GlanceFigure {
  const dates = stripDates(ctx.today)
  const { from: baselineFrom, to: baselineTo } = baselineWindow(ctx.today)
  const sums = new Map<string, number>()
  const feeding: string[] = []
  for (const metric of ACTIVE_MINUTE_METRICS) {
    for (const point of lookBackPoints(ctx, metric, 'sum', ctx.today)) {
      sums.set(point.localDate, (sums.get(point.localDate) ?? 0) + point.value)
      feeding.push(...sourcesOf(point))
    }
  }
  const baselineValues = [...sums].filter(([date]) => date >= baselineFrom && date <= baselineTo).map(([, value]) => value)
  const baseline = baselineOf(baselineValues)
  const band = toGlanceBaseline(baseline)
  const value = sums.get(ctx.today) ?? null
  return {
    metric: 'active_minutes',
    value,
    unit: 'minutes',
    baseline: band,
    asOfDate: value === null ? null : ctx.today,
    asOfMs: value === null ? null : lastSampleMs(ctx, ACTIVE_MINUTE_METRICS),
    partial: true,
    staleSources: staleFeeding(ctx, feeding),
    strip: dates.map((localDate) => ({ localDate, value: sums.get(localDate) ?? null })),
    standing: standingOf(value, band, true),
  }
}

export interface GlanceSleep {
  localDate: string
  sourceId: string
  startMs: number
  endMs: number
  startOffsetMinutes: number
  endOffsetMinutes: number
  segments: NightSegment[]
  asleep: GlanceFigure
  efficiency: GlanceFigure
  bedtime: GlanceFigure
  waketime: GlanceFigure
}

/**
 * Last night is the main sleep with the latest end that finished in the 36 hours before now.
 *
 * Chosen by when a night ended rather than by the date it is filed under, so the rule does not
 * depend on which date key a night carries. Thirty-six hours reaches back past one missed night
 * without reaching two, and a night still in progress at `nowMs` is not last night yet. Naps are
 * never last night: readSleepNights already files them apart from the night.
 */
export const LAST_NIGHT_WINDOW_MS = 36 * 3_600_000

export function readLastNight(ctx: GlanceContext): GlanceSleep | null {
  const nights = oneNightPerDate(ctx.q.sleepNights({ from: shiftLocalDate(ctx.today, -2), to: ctx.today }))
  const candidates = nights.filter((n) => n.endMs <= ctx.nowMs && n.endMs >= ctx.nowMs - LAST_NIGHT_WINDOW_MS)
  const night = candidates.reduce<(typeof candidates)[number] | null>((best, n) => (best === null || n.endMs > best.endMs ? n : best), null)
  if (night === null) return null
  const figure = (metric: string, agg: string) =>
    dailyFigure(ctx, { metric, agg, on: night.localDate, partial: false, asOfMs: night.endMs })
  return {
    localDate: night.localDate,
    sourceId: night.sourceId,
    startMs: night.startMs,
    endMs: night.endMs,
    startOffsetMinutes: night.startOffsetMinutes,
    endOffsetMinutes: night.endOffsetMinutes,
    segments: night.segments,
    asleep: figure('sleep_asleep_minutes', 'sum'),
    efficiency: figure('sleep_efficiency', 'last'),
    bedtime: figure('sleep_bedtime_minutes', 'last'),
    waketime: figure('sleep_waketime_minutes', 'last'),
  }
}

export interface GlanceRecovery {
  /**
   * The 0-100 index as a figure, for the latest of today and yesterday that scored, `asOfDate`
   * naming which; `value` null when neither did. Its strip still ends on today.
   */
  index: GlanceFigure
  /** The band of the day `index.asOfDate` names. */
  band: RecoveryBand | null
  /** Why today could not be scored, the index's own reasons; null when today or yesterday scored. */
  missing: string[] | null
  /** Today's, or yesterday's while today has none yet; `asOfDate` says which. */
  restingHeartRate: GlanceFigure
  /** Today's, or yesterday's while today has none yet; `asOfDate` says which. */
  hrv: GlanceFigure
  /** Present only on a day it sits above its baseline's high; never on a thin baseline. */
  respiratoryRate: GlanceFigure | null
}

/**
 * Today's recovery: the index, the two readings people check beside it, and respiratory rate only
 * when it says something.
 *
 * HRV is shown although it is also the index's heaviest input (0.35): beside the index it explains
 * the number rather than repeating it, and it is the figure people look for. Respiratory rate
 * barely moves from day to day, so as a permanent figure it would read "usual" nearly every
 * morning; it appears only on a day it rises above its own baseline, because a rise is an early
 * sign of illness. A thin baseline cannot say "above", so it never shows on one.
 *
 * The index figure has no baseline of its own: it already is a distance from the person's own
 * baselines, and a baseline of that would be a baseline of a baseline.
 */
export function readRecovery(ctx: GlanceContext): GlanceRecovery {
  const dates = stripDates(ctx.today)
  const yesterday = shiftLocalDate(ctx.today, -1)
  const { input } = readRecoveryInput(ctx.q, { from: dates[0]!, to: ctx.today })
  const series = recoveryIndexSeries(input, { from: dates[0]!, to: ctx.today })
  const today = series.get(ctx.today)
  const scoredOn = (localDate: string) => {
    const day = series.get(localDate)
    return day !== undefined && day.enough ? { localDate, score: day.score } : null
  }
  // Today's HRV and resting heart rate arrive only once the watch syncs the night, so every
  // morning before that the section would be empty although yesterday's are sitting right there.
  // Falling back one day, and only one, keeps the morning glance useful without passing off a
  // stale week as current: `asOfDate` says which day each value is.
  const scored = scoredOn(ctx.today) ?? scoredOn(yesterday)

  const figure = (metric: string) => {
    const onToday = dailyFigure(ctx, { metric, agg: 'last', on: ctx.today, partial: false, asOfMs: null })
    return onToday.value !== null ? onToday : dailyFigure(ctx, { metric, agg: 'last', on: yesterday, partial: false, asOfMs: null })
  }
  const restingHeartRate = figure('resting_heart_rate')
  const hrv = figure('daily_hrv')
  const respiratory = figure('respiratory_rate')
  const elevated = respiratory.value !== null && respiratory.baseline !== null && !respiratory.baseline.thin
    && respiratory.value > respiratory.baseline.high

  return {
    index: {
      metric: 'recovery_index',
      value: scored?.score ?? null,
      unit: 'score',
      baseline: null,
      asOfDate: scored?.localDate ?? null,
      asOfMs: null,
      partial: false,
      staleSources: staleFeeding(ctx, [...restingHeartRate.staleSources, ...hrv.staleSources].map((s) => s.sourceId)),
      strip: dates.map((localDate) => {
        const day = series.get(localDate)
        return { localDate, value: day !== undefined && day.enough ? day.score : null }
      }),
      standing: null,
    },
    band: scored === null ? null : bandOf(scored.score),
    // Reported only when neither day scored, and then with today's reasons: yesterday's score
    // answers the section, and today's gaps are what the person can still do something about.
    missing: scored !== null || today === undefined || today.enough ? null : [...today.missing],
    restingHeartRate,
    hrv,
    respiratoryRate: elevated ? respiratory : null,
  }
}

export function readDay(ctx: GlanceContext): GlanceDay {
  const heart = ctx.q.intraday({ metric: 'heart_rate', localDate: ctx.today, points: HEART_RATE_POINTS })
  const heartAsOf = heart.points.reduce<number | null>((latest, p) => (latest === null || p.utcMs > latest ? p.utcMs : latest), null)
  // Stale sources from heart rate's daily rows over the look-back, not from today's samples: a
  // source with a sample today is reporting by definition, so today's samples could never name one.
  const heartFeeding = lookBackPoints(ctx, 'heart_rate', 'mean', ctx.today).flatMap(sourcesOf)
  return {
    steps: dailyFigure(ctx, { metric: 'steps', agg: 'sum', on: ctx.today, partial: true, asOfMs: lastSampleMs(ctx, ['steps']) }),
    activeMinutes: activeMinutesFigure(ctx),
    heartRate: { points: heart.points, asOfMs: heartAsOf, staleSources: staleFeeding(ctx, heartFeeding) },
    // Filed under the date a workout ended on, the same key the Activity list groups by, so a run
    // that crosses midnight is today's once it is over rather than yesterday's.
    workouts: ctx.q.sessions({ kind: 'exercise', from: ctx.today, to: ctx.today }),
  }
}

export interface Glance {
  /** The local date this was assembled for, in the person's own zone. */
  today: string
  sleep: GlanceSleep | null
  recovery: GlanceRecovery
  day: GlanceDay
}

export function readGlance(
  q: PersonQuery, input: { today: string, nowMs: number, nameOf: (id: string) => string },
): Glance {
  const ctx = contextFor(q, input)
  // No generation time in the body: /glance is hashed for its ETag, and a stamp of now would make
  // every response differ, so no conditional request could ever answer 304.
  return { today: input.today, sleep: readLastNight(ctx), recovery: readRecovery(ctx), day: readDay(ctx) }
}
