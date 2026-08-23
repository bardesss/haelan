/**
 * A person's own baseline for a metric, computed from the daily rows rather than stored.
 *
 * Sixty rows is a cheap query, and a stored baseline can disagree with the rows it came from
 * while a computed one cannot. Overridden days need no handling here: an override applies at
 * derivation, so an excluded day has no daily row and a corrected one already carries its new
 * value. Reading `daily` excludes overridden values by construction.
 */

/** The default window. Long enough to survive a bad week, short enough to follow a real change. */
export const BASELINE_WINDOW_DAYS = 60

/**
 * Below this many contributing days a baseline is reported thin. The threshold lives here so a
 * dashboard band and an agent's effect size cannot disagree about what thin means.
 */
export const BASELINE_MIN_DAYS = 14

export interface Baseline {
  center: number
  /** Sample standard deviation. Zero when a single day contributed, where it is undefined. */
  spread: number
  /** Days that contributed. Days with no row are absent rather than zero. */
  n: number
  thin: boolean
}

/**
 * Null rather than a zero baseline when nothing contributed. A person with no history has no
 * baseline, and zero would be a claim about them rather than an absence of one.
 */
export function baselineOf(
  values: readonly number[],
  minDays: number = BASELINE_MIN_DAYS,
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

  return { center, spread, n, thin: n < minDays }
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
