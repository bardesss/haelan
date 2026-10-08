import { shiftLocalDate } from '../derive/localDay.ts'
import { baselineOf, BASELINE_WINDOW_DAYS } from './baseline.ts'

/**
 * HRV deviation: whether a person's HRV has stayed away from their own usual for a stretch, as
 * opposed to one low or high night. Spec: docs/superpowers/specs/2026-10-08-hrv-deviation-design.md.
 *
 * Everything is judged on ln(RMSSD). RMSSD is right-skewed, so a few very high nights pull a raw
 * mean and inflate a raw spread; on the log scale they do not. Values leave this module converted
 * back to ms, which is why a band reads slightly wider above its centre than below it.
 *
 * Separate from the recovery index on purpose: that is a daily figure, this is a stretch, and it
 * changes nothing the index computes.
 */

/** The rolling week: D-6..D. */
export const HRV_WEEK_DAYS = 7

/** The same four-of-seven floor `MIN_SLEEP_NIGHTS` holds the sleep week to, for the same reason. */
export const HRV_WEEK_MIN_READINGS = 4

/**
 * The band's half-width, in units of the baseline's spread of DAILY ln values.
 *
 * Narrower than the ±1 a daily dot is judged by, because a 7-day mean moves far less than one day
 * does, and a band sized for days would almost never be crossed by a week. A proposal pending
 * probe/scripts/hrv-deviation.mjs, which has not been run yet: it scores each person's history at
 * several band widths and reports the share of days left unmeasured, runs started per 30 measured
 * days on each side, and their lengths. Settle the width there, not in a test.
 */
export const HRV_DEVIATION_BAND = 0.5

/**
 * Measured days in a row on one side before a stretch is called one. A proposal pending the same
 * probe, which reports the same run counts and lengths at each minimum it tries beside each band.
 */
export const HRV_DEVIATION_MIN_RUN = 3

/**
 * How far back a run is counted. A dip longer than the baseline window has, by construction,
 * become part of its own baseline, so past this a run reads "more than 60 days" rather than a
 * number that would be measuring a moving target.
 */
export const HRV_DEVIATION_LOOKBACK_DAYS = 60

/** One day's HRV. `filled` when it is the intraday mean standing in for a daily reading. */
export interface HrvReading {
  localDate: string
  value: number
  filled?: boolean
}

export type HrvSide = 'below' | 'within' | 'above'

export type HrvDeviationDay =
  | { localDate: string, measured: true, rolling: number, band: { low: number, high: number }, side: HrvSide }
  | { localDate: string, measured: false, reason: 'thin-week' | 'thin-baseline' | 'flat-baseline' }

export interface HrvDeviationRun {
  side: 'below' | 'above'
  /** Measured days in the run. Unmeasured days inside it are skipped, not counted. */
  days: number
  /** True only when the walk did not end on a within/other-side day AND the lookback's first day is itself measured on the run's side. */
  capped: boolean
  /** The earliest measured day of the run. */
  since: string
  /** Of the readings in the last seven days (`on` and the six before it), how many sat outside the band on the run's side. */
  sideNights: number
  /** How many readings the last seven days hold: `sideNights` is out of this, not out of seven. */
  weekReadings: number
  /** Readings inside the run whose HRV was filled from the intraday mean. */
  filledDays: number
}

/**
 * The baseline behind day `on`: 60 days ending the day before its week begins. Ending at `on - 1`
 * instead would let a three-week dip slowly become its own usual and hide itself.
 */
export function hrvBaselineWindow(on: string): { from: string, to: string } {
  const to = shiftLocalDate(on, -HRV_WEEK_DAYS)
  return { from: shiftLocalDate(to, -(BASELINE_WINDOW_DAYS - 1)), to }
}

/**
 * The first local date a caller must fetch to score `from` AND count a full lookback behind any
 * date from `from` on: the lookback's first day, then that day's own week and baseline. Exported
 * for the reason `recoveryWindowStart` is - a caller doing its own arithmetic can be one day off
 * and still get an answer.
 */
export function hrvDeviationWindowStart(from: string): string {
  return shiftLocalDate(from, -(HRV_DEVIATION_LOOKBACK_DAYS - 1) - (BASELINE_WINDOW_DAYS + HRV_WEEK_DAYS - 1))
}

/** Below this a spread on the log scale is rounding, not variation (real spreads are ~1e-1). */
const FLAT_SPREAD_EPSILON = 1e-9

const meanOf = (values: readonly number[]): number => values.reduce((t, v) => t + v, 0) / values.length

/** ln(0) is -Infinity and ln of a negative is NaN; one such reading would poison every mean it reaches. */
const positiveOnly = (readings: readonly HrvReading[]): HrvReading[] => readings.filter((r) => r.value > 0)

/**
 * Every date in `range`, oldest first. Dates compare as text, the convention recoveryIndex.ts and
 * trainingLoad.ts use.
 *
 * `band` is the half-width in baseline spreads, defaulting to the shipped constant. It is a
 * parameter so probe/scripts/hrv-deviation.mjs can compare widths without editing the module.
 */
export function hrvDeviationSeries(
  readings: readonly HrvReading[],
  range: { from: string, to: string },
  band: number = HRV_DEVIATION_BAND,
): HrvDeviationDay[] {
  readings = positiveOnly(readings)
  const out: HrvDeviationDay[] = []
  for (let date = range.from; date <= range.to; date = shiftLocalDate(date, 1)) {
    const weekFrom = shiftLocalDate(date, -(HRV_WEEK_DAYS - 1))
    const week = readings.filter((r) => r.localDate >= weekFrom && r.localDate <= date).map((r) => Math.log(r.value))
    if (week.length < HRV_WEEK_MIN_READINGS) {
      out.push({ localDate: date, measured: false, reason: 'thin-week' })
      continue
    }
    const window = hrvBaselineWindow(date)
    const history = readings
      .filter((r) => r.localDate >= window.from && r.localDate <= window.to)
      .map((r) => Math.log(r.value))
    const baseline = baselineOf(history, BASELINE_WINDOW_DAYS)
    if (baseline === null || baseline.thin) {
      out.push({ localDate: date, measured: false, reason: 'thin-baseline' })
      continue
    }
    // Not `=== 0`: the mean of sixty identical ln values is off from the value by a few ulps, so a
    // truly flat baseline arrives with a spread near 1e-16 rather than exactly zero.
    if (baseline.spread < FLAT_SPREAD_EPSILON) {
      out.push({ localDate: date, measured: false, reason: 'flat-baseline' })
      continue
    }
    const rolling = meanOf(week)
    const low = baseline.center - band * baseline.spread
    const high = baseline.center + band * baseline.spread
    const side: HrvSide = rolling < low ? 'below' : rolling > high ? 'above' : 'within'
    out.push({
      localDate: date, measured: true, rolling: Math.exp(rolling),
      band: { low: Math.exp(low), high: Math.exp(high) }, side,
    })
  }
  return out
}

/**
 * The run that `on` belongs to, or null when there is none: `on` unmeasured or within its band, or
 * fewer than `HRV_DEVIATION_MIN_RUN` measured days on its side.
 *
 * Walks back from `on` over the lookback. A measured day on the same side counts; an unmeasured
 * day is skipped, neither counting nor ending the run, so "9 days" is nine days actually measured;
 * a day within the band or on the other side ends it.
 */
export function hrvDeviationRun(readings: readonly HrvReading[], on: string): HrvDeviationRun | null {
  readings = positiveOnly(readings)
  const from = shiftLocalDate(on, -(HRV_DEVIATION_LOOKBACK_DAYS - 1))
  const series = hrvDeviationSeries(readings, { from, to: on })
  const today = series.at(-1)!
  if (!today.measured || today.side === 'within') return null
  const side = today.side

  let days = 0
  let since = on
  let capped = true
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const day = series[i]!
    if (!day.measured) continue
    if (day.side !== side) { capped = false; break }
    days += 1
    since = day.localDate
  }
  if (days < HRV_DEVIATION_MIN_RUN) return null
  // The walk can run out because the lookback's earliest days were unmeasured, which says nothing
  // about the run continuing; only a measured first day on the run's side shows it reached the cap.
  const first = series[0]!
  if (capped && !(first.measured && first.side === side)) capped = false

  const weekFrom = shiftLocalDate(on, -(HRV_WEEK_DAYS - 1))
  const week = readings.filter((r) => r.localDate >= weekFrom && r.localDate <= on)
  const sideNights = week.filter((r) => (side === 'below' ? r.value < today.band.low : r.value > today.band.high)).length
  const filledDays = readings.filter((r) => r.localDate >= since && r.localDate <= on && r.filled === true).length
  return { side, days, capped, since, sideNights, weekReadings: week.length, filledDays }
}
