import { shiftLocalDate } from '../derive/localDay.ts'
import { BASELINE_WINDOW_DAYS, baselineOf, baselineWindow, zScoreOf } from '../query/baseline.ts'

/** One observed day of one metric. A day nobody wore a device is ABSENT, never present as zero. */
export interface DayValue {
  localDate: string
  value: number
}

export type RecoveryInputKey = 'hrv' | 'restingHeartRate' | 'sleep' | 'respiratoryRate'

/** The sleep input is a week, matching the app's own "afgelopen week aan slaap". */
export const SLEEP_WEEK_DAYS = 7

/**
 * The first local date a caller must fetch in order to score `endDate`.
 *
 * Scoring day D reads a baseline over [D-60, D-1]. Each day in that baseline carries a sleep week
 * of its own, so the oldest baseline day needs the six days before it: D-60-6 = D-66.
 *
 * Exported for the same reason `chronicWindowStart` is: a caller computing its own start can
 * quietly ask for 65 days or 67 and still get an answer, and the baseline would then be measuring
 * a window nobody chose.
 */
export function recoveryWindowStart(endDate: string): string {
  return shiftLocalDate(endDate, -(BASELINE_WINDOW_DAYS + SLEEP_WEEK_DAYS - 1))
}

/** Which way is better. `down` flips the sign so positive always means better recovered. */
export type Direction = 'up' | 'down'

export interface DateRange {
  from: string
  to: string
}

/**
 * Sign-corrected z-scores for every date in `range`, against a rolling 60-day baseline ending the
 * day before each one.
 *
 * Null where the day has no value, where its baseline is thin, or where the spread is zero — the
 * three cases `baselineOf` and `zScoreOf` already distinguish, kept distinct here rather than
 * collapsed into a number that would read as "average".
 *
 * Dates are compared as text. `YYYY-MM-DD` sorts lexicographically, so a window test needs no
 * parsing and no timezone question, the same convention `trainingLoad` uses.
 */
export function zSeries(
  days: readonly DayValue[],
  range: DateRange,
  direction: Direction,
): Map<string, number | null> {
  const byDate = new Map(days.map((day) => [day.localDate, day.value]))
  const sorted = [...days].sort((a, b) => a.localDate < b.localDate ? -1 : 1)
  const out = new Map<string, number | null>()

  for (let date = range.from; date <= range.to; date = shiftLocalDate(date, 1)) {
    const value = byDate.get(date)
    if (value === undefined) {
      out.set(date, null)
      continue
    }
    const { from: windowFrom, to: windowTo } = baselineWindow(date)
    const history = sorted
      .filter((day) => day.localDate >= windowFrom && day.localDate <= windowTo)
      .map((day) => day.value)
    const baseline = baselineOf(history)
    if (baseline === null || baseline.thin) {
      out.set(date, null)
      continue
    }
    const z = zScoreOf(value, baseline)
    out.set(date, z === null ? null : (direction === 'down' ? -z : z))
  }
  return out
}
