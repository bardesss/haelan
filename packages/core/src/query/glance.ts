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

export interface GlanceStripDay { localDate: string, value: number | null, standing: GlanceStanding | null }

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

/**
 * A strip of days, each carrying its own verdict against `band`: `partial` applies only to
 * `ownDate`, the figure's own day, never to an earlier finished day in the same strip. One
 * implementation for dailyFigure, activeMinutesFigure and the recovery index strip, so the three
 * cannot drift onto different rules for what a strip day's standing means.
 */
function stripOf(
  dates: readonly string[], valueOf: (localDate: string) => number | null,
  band: GlanceBaseline | null, ownDate: string, partial: boolean,
): GlanceStripDay[] {
  return dates.map((localDate) => {
    const value = valueOf(localDate)
    return { localDate, value, standing: standingOf(value, band, partial && localDate === ownDate) }
  })
}

/** What every section reads: the person's query, their today, now, and who has gone quiet. */
export interface GlanceContext {
  q: PersonQuery
  today: string
  nowMs: number
  /** Stale sources by id, from sourceActivity, judged against `today`. */
  stale: ReadonlyMap<string, { lastReportedDate: string, medianGapDays: number | null }>
  nameOf: (sourceId: string) => string
  /**
   * True when `today` names a day already over, built as if `nowMs` were its last millisecond
   * (M9c: day navigation). Every "today so far" figure reads this rather than comparing `today`
   * to a real clock, which core has no access to.
   */
  finished: boolean
}

const STRIP_DAYS = 7

export function contextFor(
  q: PersonQuery, input: { today: string, nowMs: number, nameOf: (id: string) => string, finished?: boolean },
): GlanceContext {
  const stale = new Map<string, { lastReportedDate: string, medianGapDays: number | null }>()
  for (const activity of q.sourceActivity({ today: input.today })) {
    if (activity.status !== 'stale' || activity.lastReportedDate === null) continue
    // A source whose data kept arriving under another id (a renamed watch) is not missing from
    // any figure, so no figure warns about it. See sourceActivity.ts.
    if (activity.continuedElsewhere) continue
    stale.set(activity.sourceId, { lastReportedDate: activity.lastReportedDate, medianGapDays: activity.medianGapDays })
  }
  return { q, today: input.today, nowMs: input.nowMs, stale, nameOf: input.nameOf, finished: input.finished ?? false }
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
    strip: stripOf(dates, (localDate) => byDate.get(localDate)?.value ?? null, band, o.on, o.partial),
    standing: standingOf(onDay?.value ?? null, band, o.partial),
  }
}

export interface GlanceStepsPace {
  /** The usual steps by `atMs`'s local minute, as a band. */
  center: number
  low: number
  high: number
  thin: boolean
  /** Today's own count, cut at the same minute as the band: what `standing` actually compares. */
  value: number
  /** Today's last step reading: the instant the comparison is made at, never now. */
  atMs: number
  standing: 'ahead' | 'on' | 'behind' | null
}

/**
 * Below this share of the day's usual whole-day total, the usual-by-now count is still near zero
 * (just after midnight), so a handful of steps would otherwise read "ahead" of it.
 */
export const PACE_MIN_DAY_SHARE = 0.05

/**
 * Today's steps against the person's usual count by the same minute of the day (spec: steps pace).
 * Measured at the last reading rather than at now, because a count synced at 13:52 compared with
 * the usual at 14:05 would call every unsynced minute a shortfall. Only baseline days that kept a
 * daily steps row count, so an excluded or silent day is absent rather than a zero.
 *
 * Compared against `read.today` - the same samples, cut at the same minute, through the same
 * selectHourWinners arithmetic as every baseline day - never against the `steps` figure's own
 * `value`. That value is `daily.steps`, which is only as fresh as the last time the derivation
 * queue drained; comparing a possibly-stale derived total against a band cut at the sample cutoff
 * mixes two different instants and can call an ordinary lag "behind" the spec's "measured at the
 * last reading" rule forbids. Pace is null only when there is no step sample today
 * (`stepsUpToMinute` returns null) or the baseline itself is (`baselineOf` returns null) - not on
 * whether the daily total has caught up yet.
 *
 * No verdict yet (`standing: null`, band still sent) while the usual-by-now count (`band.center`)
 * sits under `PACE_MIN_DAY_SHARE` of the day's usual whole-day total: just after midnight the usual
 * count by now is itself near zero, so even a handful of today's own steps would otherwise read
 * "ahead".
 */
export function readStepsPace(ctx: GlanceContext): GlanceStepsPace | null {
  const window = baselineWindow(ctx.today)
  const read = ctx.q.stepsUpToMinute({ today: ctx.today, ...window })
  if (read === null) return null
  const withRow = new Set(ctx.q.series({ metric: 'steps', agg: 'sum', ...window }).points.map((p) => p.localDate))
  const values = [...read.sums].filter(([date]) => withRow.has(date)).map(([, sum]) => sum)
  const baseline = baselineOf(values)
  if (baseline === null) return null
  const band = toGlanceBaseline(baseline)!
  const dayBaseline = ctx.q.baseline({ metric: 'steps', agg: 'sum', on: ctx.today })
  const tooEarly = dayBaseline === null || dayBaseline.thin || band.center < PACE_MIN_DAY_SHARE * dayBaseline.center
  const standing = band.thin || tooEarly ? null : read.today > band.high ? 'ahead' : read.today < band.low ? 'behind' : 'on'
  return { ...band, value: read.today, atMs: read.atMs, standing }
}

export interface GlanceHeartRate { points: IntradayPoint[], asOfMs: number | null, staleSources: GlanceStaleSource[] }
export interface GlanceDay {
  steps: GlanceFigure
  stepsPace: GlanceStepsPace | null
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
  const partial = !ctx.finished
  return {
    metric: 'active_minutes',
    value,
    unit: 'minutes',
    baseline: band,
    asOfDate: value === null ? null : ctx.today,
    asOfMs: value === null ? null : lastSampleMs(ctx, ACTIVE_MINUTE_METRICS),
    partial,
    staleSources: staleFeeding(ctx, feeding),
    strip: stripOf(dates, (localDate) => sums.get(localDate) ?? null, band, ctx.today, partial),
    standing: standingOf(value, band, partial),
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
      strip: stripOf(dates, (localDate) => {
        const day = series.get(localDate)
        return day !== undefined && day.enough ? day.score : null
      }, null, ctx.today, false),
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
  const steps = dailyFigure(ctx, { metric: 'steps', agg: 'sum', on: ctx.today, partial: !ctx.finished, asOfMs: lastSampleMs(ctx, ['steps']) })
  return {
    steps,
    stepsPace: ctx.finished ? null : readStepsPace(ctx),
    activeMinutes: activeMinutesFigure(ctx),
    heartRate: { points: heart.points, asOfMs: heartAsOf, staleSources: staleFeeding(ctx, heartFeeding) },
    // Filed under the date a workout ended on, the same key the Activity list groups by, so a run
    // that crosses midnight is today's once it is over rather than yesterday's.
    workouts: ctx.q.sessions({ kind: 'exercise', from: ctx.today, to: ctx.today }),
  }
}

export interface GlanceWeekFigure { perDay: number, days: number, total: number }

/** The last seven days as averages over the finished ones; today is drawn by the client, never counted (spec: WeekCard). */
export interface GlanceWeek { steps: GlanceWeekFigure | null, activeMinutes: GlanceWeekFigure | null, asleep: GlanceWeekFigure | null }

/** The sum of every strip day with a value, the figure's own day included (for today's steps/active that is "so far"). */
function stripTotal(strip: readonly GlanceStripDay[]): number {
  return strip.map((d) => d.value).filter((v): v is number => v !== null).reduce((s, v) => s + v, 0)
}

/** A strip's finished days averaged. The last entry is the figure's own day and is left out: on the today figures it is still running. */
export function weekOf(strip: readonly GlanceStripDay[]): GlanceWeekFigure | null {
  const finished = strip.slice(0, -1).map((d) => d.value).filter((v): v is number => v !== null)
  if (finished.length === 0) return null
  return { perDay: finished.reduce((s, v) => s + v, 0) / finished.length, days: finished.length, total: stripTotal(strip) }
}

/**
 * The same average as `weekOf`, but over the whole strip: a sleep strip ends on last night, which
 * has already finished, so there is no running day at the end to leave out.
 */
export function weekOfFinished(strip: readonly GlanceStripDay[]): GlanceWeekFigure | null {
  const finished = strip.map((d) => d.value).filter((v): v is number => v !== null)
  if (finished.length === 0) return null
  return { perDay: finished.reduce((s, v) => s + v, 0) / finished.length, days: finished.length, total: stripTotal(strip) }
}

/** The nearest days with data before and after this glance's own day, up to and including today. */
export interface GlanceNav { previous: string | null, next: string | null }

export interface Glance {
  /** The local date this was assembled for, in the person's own zone. */
  today: string
  sleep: GlanceSleep | null
  recovery: GlanceRecovery
  day: GlanceDay
  /** The last seven days' averages, alongside `day` and `sleep` rather than replacing them. */
  week: GlanceWeek
  /** True when `today` names a day already over, rather than the day still running (M9c). */
  finished: boolean
  /** Where the day-navigation arrows on a finished day's page go. */
  nav: GlanceNav
}

export function readGlance(
  q: PersonQuery,
  input: { today: string, nowMs: number, nameOf: (id: string) => string, day?: string, dayEndMs?: number },
): Glance {
  const realToday = input.today
  const finished = input.day !== undefined
  const ctx = contextFor(q, {
    today: finished ? input.day! : input.today,
    nowMs: finished ? input.dayEndMs! : input.nowMs,
    nameOf: input.nameOf,
    finished,
  })
  const sleep = readLastNight(ctx)
  const day = readDay(ctx)
  // The week's asleep figure is computed from the seven nights ending on last night's own date
  // when there is one, or on yesterday when the watch has not synced yet: a morning before it has
  // must not drop six already-finished nights from the week card for want of a seventh (Task 19a).
  const asleepStrip = sleep !== null
    ? sleep.asleep.strip
    : dailyFigure(ctx, { metric: 'sleep_asleep_minutes', agg: 'sum', on: shiftLocalDate(ctx.today, -1), partial: false, asOfMs: null }).strip
  // A finished day's own strip day is a whole day like every other in it, so its week average
  // includes it (weekOfFinished) rather than treating it as still running (weekOf).
  const week: GlanceWeek = {
    steps: finished ? weekOfFinished(day.steps.strip) : weekOf(day.steps.strip),
    activeMinutes: finished ? weekOfFinished(day.activeMinutes.strip) : weekOf(day.activeMinutes.strip),
    asleep: weekOfFinished(asleepStrip),
  }
  const nav: GlanceNav = {
    previous: q.nearestDayWithData({ on: ctx.today, direction: 'before' }),
    next: q.nearestDayWithData({ on: ctx.today, direction: 'after', until: realToday }),
  }
  // No generation time in the body: /glance is hashed for its ETag, and a stamp of now would make
  // every response differ, so no conditional request could ever answer 304.
  return { today: ctx.today, sleep, recovery: readRecovery(ctx), day, week, finished, nav }
}
