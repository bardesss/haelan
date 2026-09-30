// The Activity overview (M10b): a week, month, three months or year of days and workouts, every
// figure judged against periods of its own length. Computed on read from existing rows, one read
// per metric and two reads of the workouts.
import { METRICS } from '../derive/metrics.ts'
import { shiftLocalDate } from '../derive/localDay.ts'
import { CARDIO_LOAD_METRIC } from '../api/cardioLoad.ts'
import { workoutDetail, workoutSummary } from '../api/workoutSummary.ts'
import type { PersonQuery } from './personQuery.ts'
import type { WorkoutSession } from './sessions.ts'
import { ACTIVE_MINUTE_METRICS, FIGURE_METRIC_ALIAS, judge, standingOf } from './glance.ts'
import type { FigureDirection, GlanceStanding, Judged } from './glance.ts'
import { usualOf } from './pageFigure.ts'
import { daysIn, earlierBlocks, minDate, periodBounds } from './periodBounds.ts'
import type { DateSpan, PeriodRange } from './periodBounds.ts'
import { blockMean, highOf, PERIOD_MIN_PERIODS, windowOf } from './periodFigure.ts'
import type { PeriodChange, PeriodFigure, PeriodHeader, PeriodHigh, PeriodUsual } from './periodFigure.ts'
import { catalogueRead, orNull, periodChanges, periodHeader, readPeriodSeries, readSpan, shown, valuesFigure } from './periodRead.ts'

export interface ActivityPeriodInput { range: PeriodRange, anchor: string, today: string, source?: string }
export interface WorkoutListRow {
  id: string, sourceId: string, localDate: string, startMs: number, endMs: number
  type: string | null, durationSeconds: number | null, distanceMeters: number | null
  caloriesKcal: number | null, averageHeartRateBpm: number | null
  paceSecondsPerKm: number | null, elevationGainMeters: number | null, excluded: boolean
}
/** A month's counted workouts (excluded ones left out), for the list's month headers on 3 months and a year. */
export interface WorkoutMonth { month: string, count: number, seconds: number }
export interface TypeTotal {
  type: string | null, count: number, seconds: number, distanceMeters: number | null
  usualCount: PeriodUsual | null, standing: GlanceStanding | null
  /** More workouts of a type than usual is the better side (TYPE_COUNT_DIRECTION). */
  judged: Judged
}
export interface Vo2Trend {
  metric: string, latest: number, latestDate: string, earlier: number | null, earlierDate: string | null
  trend: 'rising' | 'falling' | 'steady' | null
}
export interface ActivityPeriod {
  period: PeriodHeader
  /** Steps, per day. */
  hero: PeriodFigure
  /** The busiest day. */
  high: PeriodHigh | null
  previous: PeriodChange
  yearEarlier: PeriodChange
  /** The period's workouts, excluded ones left out. */
  workoutCount: number
  /** Active minutes (per week), distance, floors, active energy, those with days. */
  figures: PeriodFigure[]
  intensity: { light: PeriodFigure | null, moderate: PeriodFigure | null, vigorous: PeriodFigure | null }
  zoneMinutes: { fatBurn: PeriodFigure | null, cardio: PeriodFigure | null, peak: PeriodFigure | null }
  /** `hard` is the vigorous and peak zones summed a day: the card's lead, "intensief of piek". */
  heartRateZones: {
    light: PeriodFigure | null, moderate: PeriodFigure | null, vigorous: PeriodFigure | null, peak: PeriodFigure | null
    hard: PeriodFigure | null
  }
  /** The day's highest heart rate, averaged over the period's days. */
  maxHeartRate: PeriodFigure | null
  /** Newest first, every workout of the period, today's and excluded ones included. */
  workouts: WorkoutListRow[]
  /** Newest first, a month each that has a counted workout. */
  workoutMonths: WorkoutMonth[]
  /** By count, descending, then type. */
  types: TypeTotal[]
  cardioLoad: PeriodFigure | null
  vo2max: Vo2Trend | null
  /** Total calories, active zone minutes, workout minutes, altitude gain, sedentary minutes, those with days. */
  more: PeriodFigure[]
}

const ZONE_METRICS = ['active_zone_minutes_fat_burn', 'active_zone_minutes_cardio', 'active_zone_minutes_peak'] as const
const HEART_RATE_ZONE_METRICS = [
  'time_in_heart_rate_zone_light_minutes', 'time_in_heart_rate_zone_moderate_minutes',
  'time_in_heart_rate_zone_vigorous_minutes', 'time_in_heart_rate_zone_peak_minutes',
] as const
export const HARD_ZONE_METRIC = 'hard_zone_minutes'
export const MAX_HEART_RATE_METRIC = 'max_heart_rate'
/** A type's count judged: more of it than usual reads as the better side. */
export const TYPE_COUNT_DIRECTION: FigureDirection = 'up'
/** In order of preference: the daily summary, the generic reading, the one a run records. */
const VO2_METRICS = ['daily_vo2_max', 'vo2_max', 'run_vo2_max'] as const
const VO2_EARLIER_DAYS = 90
const VO2_TREND_STEP = 1

/** The per-day sum of several series, on the days at least one of them has a value (activeMinutesFigure's sum). */
function summed(parts: readonly ReadonlyMap<string, number>[]): Map<string, number> {
  const sums = new Map<string, number>()
  for (const values of parts) for (const [date, v] of values) sums.set(date, (sums.get(date) ?? 0) + v)
  return sums
}

const within = (date: string, span: DateSpan) => date >= span.from && date <= span.to

function rowOf(w: WorkoutSession): WorkoutListRow {
  const summary = workoutSummary(w.attrs)
  const detail = workoutDetail(w.attrs)
  return {
    id: w.id, sourceId: w.sourceId, localDate: w.localDate, startMs: w.startMs, endMs: w.endMs,
    type: summary.exerciseType,
    durationSeconds: detail.activeDurationSeconds ?? (w.endMs - w.startMs) / 1000,
    distanceMeters: summary.distanceMeters, caloriesKcal: summary.caloriesKcal, averageHeartRateBpm: summary.averageHeartRateBpm,
    paceSecondsPerKm: summary.paceSecondsPerKm, elevationGainMeters: summary.elevationGainMeters,
    excluded: w.excluded,
  }
}

/**
 * The counted workouts a month each, newest first, from rows already newest first: the route runs it
 * again on the rounded rows, so a header's time is the sum of the times its rows print.
 */
export function workoutMonths(rows: readonly WorkoutListRow[]): WorkoutMonth[] {
  const months = new Map<string, WorkoutMonth>()
  for (const w of rows) {
    if (w.excluded) continue
    const month = w.localDate.slice(0, 7)
    const own = months.get(month) ?? { month, count: 0, seconds: 0 }
    months.set(month, { month, count: own.count + 1, seconds: own.seconds + (w.durationSeconds ?? 0) })
  }
  return [...months.values()].sort((a, b) => (a.month < b.month ? 1 : -1))
}

const byType = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1)

/**
 * The usual count of each type, over the earlier blocks the person has daily data in. A block before
 * the history began is not a block without workouts, so it is left out rather than counted as zero.
 */
function typesOf(
  counted: readonly WorkoutListRow[], earlierTypes: readonly { localDate: string, type: string | null }[],
  range: PeriodRange, bounds: DateSpan, steps: ReadonlyMap<string, number>, partial: boolean,
): TypeTotal[] {
  const { unit, blocks } = earlierBlocks(range, bounds)
  const observed = blocks.filter((b) => blockMean(steps, b, b.to).mean !== null)
  const window = windowOf(unit, blocks)
  const groups = new Map<string | null, WorkoutListRow[]>()
  for (const w of counted) groups.set(w.type, [...(groups.get(w.type) ?? []), w])
  return [...groups].map(([type, rows]): TypeTotal => {
    // Each block's count scaled to the period's length, the rate the figures compare per day: a year
    // is judged against the previous year's quarters, and a 31-day month against months of 28 to 31.
    const counts = observed.map((b) =>
      earlierTypes.filter((w) => w.type === type && within(w.localDate, b)).length * daysIn(bounds) / daysIn(b))
    const usual = usualOf(counts, PERIOD_MIN_PERIODS[range])
    const usualCount = usual === null ? null : { ...usual, window, periods: counts.length }
    const distances = rows.flatMap((w) => (w.distanceMeters === null ? [] : [w.distanceMeters]))
    // A running period's count so far is not judged against a whole period's usual.
    const standing = standingOf(rows.length, usualCount, partial)
    return {
      type, count: rows.length,
      seconds: rows.reduce((s, w) => s + (w.durationSeconds ?? 0), 0),
      distanceMeters: distances.length === 0 ? null : distances.reduce((s, d) => s + d, 0),
      usualCount, standing, judged: judge(standing, TYPE_COUNT_DIRECTION),
    }
  }).sort((a, b) => b.count - a.count || byType(a.type, b.type))
}

/** The VO2 max trend from the latest reading and the one about three months before it; the route recomputes it from the rounded pair. */
export function vo2TrendOf(latest: number, earlier: number | null): Vo2Trend['trend'] {
  // Rounded to the tenth the readings carry, so 31.3 to 32.3 is a rise of one, not of 0.9999999999999964.
  const diff = earlier === null ? null : Math.round((latest - earlier) * 10) / 10
  return diff === null ? null : diff >= VO2_TREND_STEP ? 'rising' : diff <= -VO2_TREND_STEP ? 'falling' : 'steady'
}

function vo2Of(q: PersonQuery, span: DateSpan, lastDay: string, source: string | undefined): Vo2Trend | null {
  for (const metric of VO2_METRICS) {
    const { points } = q.series({ metric, agg: 'last', from: span.from, to: lastDay, source })
    const last = points[points.length - 1]
    if (last === undefined) continue
    const cutoff = shiftLocalDate(last.localDate, -VO2_EARLIER_DAYS)
    const before = points.filter((p) => p.localDate <= cutoff)
    const earlier = before[before.length - 1] ?? null
    return {
      metric, latest: last.value, latestDate: last.localDate,
      earlier: earlier?.value ?? null, earlierDate: earlier?.localDate ?? null, trend: vo2TrendOf(last.value, earlier?.value ?? null),
    }
  }
  return null
}

export function readActivityPeriod(q: PersonQuery, input: ActivityPeriodInput): ActivityPeriod {
  const { range, anchor, source, today } = input
  const bounds = periodBounds(range, anchor)
  // Today is still running: no figure is judged on a partial day, as the glance's rule goes.
  const yesterday = shiftLocalDate(today, -1)
  const lastDay = minDate(yesterday, bounds.to)
  const span = readSpan(range, bounds)
  const base = { range, anchor, bounds, span, lastDay, source }
  const read = (metric: string) => catalogueRead(q, { ...base, metric, agg: 'sum' })
  const figure = (metric: string) => read(metric).figure

  // Figures over per-day sums of series already read, banded in memory as `baselines` would.
  const sumFigure = (metric: string, o: { unit: string, precision: number, direction: FigureDirection, per?: 'day' | 'week' }, values: Map<string, number>) =>
    valuesFigure({ metric, ...o, range, anchor, bounds, lastDay, values, additive: true })

  const steps = read('steps')
  const hero = steps.figure
  const levels = ACTIVE_MINUTE_METRICS.map(read)
  const activeSpec = METRICS[FIGURE_METRIC_ALIAS.active_minutes!]!
  const activeMinutes = sumFigure('active_minutes', {
    unit: activeSpec.unit, precision: activeSpec.precision, direction: activeSpec.direction, per: 'week',
  }, summed(levels.map((l) => l.series.values)))
  const zones = ZONE_METRICS.map(read)
  const zoneTotal = sumFigure('active_zone_minutes', { unit: 'minutes', precision: 0, direction: 'up' }, summed(zones.map((z) => z.series.values)))
  const [hrLight, hrModerate, hrVigorous, hrPeak] = HEART_RATE_ZONE_METRICS.map(read)
  const hrSpec = METRICS[HEART_RATE_ZONE_METRICS[2]]!
  const hard = sumFigure(HARD_ZONE_METRIC, { unit: hrSpec.unit, precision: hrSpec.precision, direction: 'up' },
    summed([hrVigorous!.series.values, hrPeak!.series.values]))
  // Each day's highest heart rate: neither side of it is better, so it is judged without a direction.
  const maxHr = readPeriodSeries(q, { ...base, metric: 'heart_rate', agg: 'max' })
  const maxHeartRate = valuesFigure({
    metric: MAX_HEART_RATE_METRIC, unit: 'bpm', precision: METRICS.heart_rate!.precision, direction: 'neutral',
    range, anchor, bounds, lastDay, values: maxHr.values, dailyBands: maxHr.bands, additive: false,
  })
  const period = periodHeader(range, bounds, today, lastDay)

  // Today's workouts are listed, though no figure counts today.
  const listTo = minDate(today, bounds.to)
  const workouts = q.sessions({ kind: 'exercise', from: bounds.from, to: listTo, sourceId: source })
    .map(rowOf).sort((a, b) => b.startMs - a.startMs)
  const counted = workouts.filter((w) => !w.excluded)
  const { blocks } = earlierBlocks(range, bounds)
  const earlierTypes = q.sessions({ kind: 'exercise', from: blocks[0]!.from, to: shiftLocalDate(bounds.from, -1), sourceId: source })
    .filter((w) => !w.excluded)
    .map((w) => ({ localDate: w.localDate, type: workoutSummary(w.attrs).exerciseType }))

  return {
    period,
    hero,
    high: highOf(hero.daily),
    ...periodChanges(steps.series.values, range, anchor, bounds, hero.value, lastDay),
    workoutCount: counted.length,
    figures: [activeMinutes, figure('distance'), figure('floors'), figure('active_energy')].filter(shown),
    intensity: { light: orNull(levels[0]!.figure), moderate: orNull(levels[1]!.figure), vigorous: orNull(levels[2]!.figure) },
    zoneMinutes: { fatBurn: orNull(zones[0]!.figure), cardio: orNull(zones[1]!.figure), peak: orNull(zones[2]!.figure) },
    heartRateZones: {
      light: orNull(hrLight!.figure), moderate: orNull(hrModerate!.figure), vigorous: orNull(hrVigorous!.figure), peak: orNull(hrPeak!.figure),
      hard: orNull(hard),
    },
    maxHeartRate: orNull(maxHeartRate),
    workouts,
    workoutMonths: workoutMonths(workouts),
    types: typesOf(counted, earlierTypes, range, bounds, steps.series.values, period.partial),
    cardioLoad: orNull(figure(CARDIO_LOAD_METRIC)),
    vo2max: vo2Of(q, span, lastDay, source),
    more: [
      figure('total_calories'), zoneTotal, figure('workout_minutes'), figure('altitude_gain'), figure('sedentary_minutes'),
    ].filter(shown),
  }
}
