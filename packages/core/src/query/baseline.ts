/**
 * A person's own baseline for a metric, computed from the daily rows rather than stored.
 *
 * Sixty rows is a cheap query, and a stored baseline can disagree with the rows it came from
 * while a computed one cannot. Overridden days need no handling here: an override applies at
 * derivation, so an excluded day has no daily row and a corrected one already carries its new
 * value. Reading `daily` excludes overridden values by construction.
 */

import { shiftLocalDate } from '../derive/localDay.ts'
import { INSIGHT_MIN_DAY_FRACTION } from './insights.ts'

/** The default window. Long enough to survive a bad week, short enough to follow a real change. */
export const BASELINE_WINDOW_DAYS = 60

/**
 * The window `baseline()` reads: back `windowDays`, ending the day before `on`, so a reading is
 * never part of the baseline it is judged against. Exported so a caller that needs the same
 * window for a different reason, such as the HTTP surface's ETag, computes it once rather than
 * growing a second copy of the rule.
 */
export function baselineWindow(on: string, windowDays: number = BASELINE_WINDOW_DAYS): { from: string, to: string } {
  const to = shiftLocalDate(on, -1)
  const from = shiftLocalDate(to, -(windowDays - 1))
  return { from, to }
}

/**
 * The statistical floor: below this many contributing days a spread is not worth standing on.
 * The threshold lives here so a dashboard band and an agent's effect size cannot disagree about
 * what thin means.
 */
export const BASELINE_MIN_DAYS = 14

export interface Baseline {
  center: number
  /** Sample standard deviation. Zero when a single day contributed, where it is undefined. */
  spread: number
  /** Days that contributed. Days with no row are absent rather than zero. */
  n: number
  /** Too few days to stand on, or too little of the window asked for. */
  thin: boolean
}

/**
 * Null rather than a zero baseline when nothing contributed. A person with no history has no
 * baseline, and zero would be a claim about them rather than an absence of one.
 */
export function baselineOf(
  values: readonly number[],
  windowDays: number = BASELINE_WINDOW_DAYS,
): Baseline | null {
  if (values.length === 0) return null

  const n = values.length
  const center = values.reduce((total, value) => total + value, 0) / n
  // The n-1 denominator estimates the spread of the population rather than describing this
  // sample, which is what a baseline is for. One day has no n-1 to divide by, and zero is the
  // honest floor: nothing varied because nothing could have.
  const spread = n < 2
    ? 0
    : Math.sqrt(values.reduce((total, value) => total + (value - center) ** 2, 0) / (n - 1))

  // Two failures, one flag. An absolute floor because a spread over three days is noise, and a
  // fraction of the window because a person who wore their device 20 of 60 days must not get a
  // confident band above a blank insight card computed from the same rows. The floor is capped
  // at the window, or a legitimate seven day trend would be thin by construction.
  const floor = Math.min(BASELINE_MIN_DAYS, windowDays)
  return { center, spread, n, thin: n < floor || n / windowDays < INSIGHT_MIN_DAY_FRACTION }
}

/**
 * Each of `days`' own baseline, from one set of daily values already read over all their windows.
 *
 * The same answer as calling `baselineOf` once per day on that day's own `baselineWindow`, which
 * is exactly what it does, only in memory: a strip of seven days or a calendar month of thirty-one
 * reads its rows once rather than once a day. `values` is keyed by local date and holds only the
 * days that contribute (a caller that drops low-coverage days drops them before this), so a day
 * with no entry is absent from the window rather than a zero, as in `baselineOf`.
 */
export function baselinesOver(
  values: ReadonlyMap<string, number>,
  days: readonly string[],
  windowDays: number = BASELINE_WINDOW_DAYS,
): Map<string, Baseline | null> {
  const out = new Map<string, Baseline | null>()
  for (const day of days) {
    const { from, to } = baselineWindow(day, windowDays)
    const inWindow: number[] = []
    for (const [date, value] of values) {
      if (date >= from && date <= to) inWindow.push(value)
    }
    out.set(day, baselineOf(inWindow, windowDays))
  }
  return out
}

/**
 * A reading as distance from the centre in units of spread, which is the sentence a baseline
 * exists to make sayable. Null where the spread is zero, because a distance measured in units
 * of nothing is not a number, and reporting it as zero or infinity would both be inventions.
 */
export function zScoreOf(value: number, baseline: Baseline): number | null {
  if (baseline.spread === 0) return null
  return (value - baseline.center) / baseline.spread
}
