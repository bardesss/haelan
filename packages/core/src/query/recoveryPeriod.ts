// The Recovery overview: a week, month, three months or year of the recovery index, the three
// figures it is made from, and the HRV stretch. Computed on read from existing rows, as Sleep's.
import type { PersonQuery } from './personQuery.ts'
import { shiftLocalDate } from '../derive/localDay.ts'
import { bandOf, RECOVERY_USUAL_BAND, RECOVERY_WEIGHTS } from '../api/recoveryIndex.ts'
import type { RecoveryBand, RecoveryIndexAvailable, RecoveryInput, RecoveryInputKey } from '../api/recoveryIndex.ts'
import { BASELINE_WINDOW_DAYS } from './baseline.ts'
import {
  HRV_DEVIATION_BAND, HRV_DEVIATION_LOOKBACK_DAYS, HRV_DEVIATION_MIN_RUN, HRV_WEEK_DAYS, HRV_WEEK_MIN_READINGS,
} from './hrvDeviation.ts'
import type { HrvDeviationDay, HrvDeviationRun } from './hrvDeviation.ts'
import { readHrvDeviation } from './hrvDeviationInput.ts'
import { recoveryIndexFigure } from './recoveryIndexFigure.ts'
import { minDate, periodBounds, weeksIn } from './periodBounds.ts'
import type { PeriodRange } from './periodBounds.ts'
import { highOf, lowOf } from './periodFigure.ts'
import type { PeriodChange, PeriodFigure, PeriodHeader, PeriodHigh } from './periodFigure.ts'
import { catalogueRead, periodChanges, periodHeader, readSpan, shown } from './periodRead.ts'

export interface RecoveryPeriodInput { range: PeriodRange, anchor: string, today: string, source?: string }
/** One scored day, for the tap panel: its score, its band, and what each input added. */
export interface RecoveryDay { localDate: string, score: number, band: RecoveryBand, inputs: RecoveryInput[] }
/** A run of the HRV stretch inside the period: its first and last measured days there. */
export interface HrvStretchSpan { from: string, to: string, side: 'below' | 'above' }
/** A Monday-to-Sunday week of the stretch, clipped to the period: its last measured day, null with none. */
export interface HrvStretchWeek { from: string, to: string, point: HrvDeviationDay | null }
export interface RecoveryStretch {
  /** Every day from the period's first to its last so far. */
  days: HrvDeviationDay[]
  /** Drawn on 3 months and a year only. */
  weeks: HrvStretchWeek[] | null
  runs: HrvStretchSpan[]
  /** The run as of the period's last day so far. */
  run: HrvDeviationRun | null
}
export interface RecoveryMethod {
  weights: Record<RecoveryInputKey, number>
  usualBand: { low: number, high: number }
  baselineDays: number
  stretch: { weekDays: number, minReadings: number, band: number, minRun: number, lookbackDays: number }
}
export interface RecoveryPeriod {
  period: PeriodHeader
  /** The index: the period against the usual for a period that long, each day against the usual band. */
  hero: PeriodFigure
  high: PeriodHigh | null
  low: PeriodHigh | null
  previous: PeriodChange
  yearEarlier: PeriodChange
  /** The input whose points pushed the period hardest the way the hero leans; null with no value. */
  carriedBy: RecoveryInputKey | null
  /** Resting heart rate, HRV, breathing rate, those with days. */
  figures: PeriodFigure[]
  /** Null when no day of the period is measured. */
  stretch: RecoveryStretch | null
  /** Every scored day, oldest first. */
  days: RecoveryDay[]
  method: RecoveryMethod
}

/**
 * The input that carried the period: each input's `contribution` (its signed weight times z, the
 * linear part of the composite) summed over the scored days, read in the direction the hero's
 * value sits from 50. Named only when its sum is at least half of every input's sum in that
 * direction added up, so a period two or more inputs moved together names none. Null too when the
 * hero has no value or nothing moved that way.
 *
 * Not `points`: those are scaled by each day's distance from 50 through the logistic, so an input
 * that only swings day to day sums to a net push and could be named over one that truly shifted.
 */
export function carriedByOf(days: readonly RecoveryDay[], value: number | null): RecoveryInputKey | null {
  if (value === null) return null
  const sums = new Map<RecoveryInputKey, number>()
  for (const day of days) for (const x of day.inputs) sums.set(x.key, (sums.get(x.key) ?? 0) + x.contribution)
  const sign = value >= 50 ? 1 : -1
  let best: RecoveryInputKey | null = null
  let bestPush = 0
  let total = 0
  for (const [key, sum] of sums) {
    const push = sum * sign
    if (push <= 0) continue
    total += push
    if (push > bestPush) { best = key; bestPush = push }
  }
  return best !== null && bestPush >= total / 2 ? best : null
}

/**
 * Streaks of measured days on one side: an unmeasured day is skipped without ending one, a day
 * within the band or on the other side ends it. Kept with at least HRV_DEVIATION_MIN_RUN measured
 * days, counted over every day given, then clipped to the measured days from `from` on.
 */
export function stretchRuns(days: readonly HrvDeviationDay[], from: string): HrvStretchSpan[] {
  const runs: HrvStretchSpan[] = []
  let streak: { side: 'below' | 'above', measured: string[] } | null = null
  const close = () => {
    if (streak === null || streak.measured.length < HRV_DEVIATION_MIN_RUN) return
    const inside = streak.measured.filter((d) => d >= from)
    if (inside.length > 0) runs.push({ from: inside[0]!, to: inside[inside.length - 1]!, side: streak.side })
  }
  for (const day of days) {
    if (!day.measured) continue
    if (day.side === 'within') { close(); streak = null; continue }
    if (streak === null || streak.side !== day.side) { close(); streak = { side: day.side, measured: [] } }
    streak.measured.push(day.localDate)
  }
  close()
  return runs
}

export function readRecoveryPeriod(q: PersonQuery, input: RecoveryPeriodInput): RecoveryPeriod {
  const { range, anchor, source } = input
  const bounds = periodBounds(range, anchor)
  // A morning's readings count on their own day, so today counts.
  const lastDay = minDate(input.today, bounds.to)
  const span = readSpan(range, bounds)
  const base = { range, anchor, bounds, span, lastDay, source }
  const figure = (metric: string) => catalogueRead(q, { ...base, metric, agg: 'last' }).figure

  // The index is scored from merged rows, whatever source the page is narrowed to. Its days are
  // judged against the usual band; the period and its weeks against periods of their own length.
  const { figure: hero, scores } = recoveryIndexFigure(q, { range, anchor, bounds, span, lastDay })
  const days: RecoveryDay[] = [...scores]
    .filter(([date]) => date >= bounds.from && date <= lastDay)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([localDate, day]: [string, RecoveryIndexAvailable]) => ({ localDate, score: day.score, band: bandOf(day.score), inputs: [...day.inputs] }))
  const values = new Map([...scores].map(([date, day]) => [date, day.score] as const))

  // Breathing rate where the archive has it, else the rate during sleep.
  const respiratory = figure('respiratory_rate')
  const breathing = shown(respiratory) ? respiratory : figure('sleep_respiratory_rate')

  return {
    period: periodHeader(range, bounds, input.today, lastDay),
    hero,
    high: highOf(hero.daily),
    low: lowOf(hero.daily),
    ...periodChanges(values, range, anchor, bounds, hero.value, lastDay),
    carriedBy: carriedByOf(days, hero.value),
    figures: [figure('resting_heart_rate'), figure('daily_hrv'), breathing].filter(shown),
    stretch: stretchOf(q, range, bounds.from, lastDay),
    days,
    method: {
      weights: { ...RECOVERY_WEIGHTS },
      usualBand: { low: RECOVERY_USUAL_BAND.low, high: RECOVERY_USUAL_BAND.high },
      baselineDays: BASELINE_WINDOW_DAYS,
      stretch: {
        weekDays: HRV_WEEK_DAYS, minReadings: HRV_WEEK_MIN_READINGS, band: HRV_DEVIATION_BAND,
        minRun: HRV_DEVIATION_MIN_RUN, lookbackDays: HRV_DEVIATION_LOOKBACK_DAYS,
      },
    },
  }
}

function stretchOf(q: PersonQuery, range: PeriodRange, from: string, lastDay: string): RecoveryStretch | null {
  // Read from a lookback before the period, so a run that began before it is counted whole and
  // kept even when only its last days fall inside.
  const read = readHrvDeviation(q, { from: shiftLocalDate(from, -HRV_DEVIATION_LOOKBACK_DAYS), to: lastDay })
  const days = read.days.filter((d) => d.localDate >= from)
  if (!days.some((d) => d.measured)) return null
  const weeks = range === '3months' || range === 'year'
    ? weeksIn({ from, to: lastDay }).map((week) => ({
      ...week,
      point: days.filter((d) => d.measured && d.localDate >= week.from && d.localDate <= week.to).at(-1) ?? null,
    }))
    : null
  return { days, weeks, runs: stretchRuns(read.days, from), run: read.run }
}
