/**
 * Whether a source is still reporting, judged against its OWN cadence rather than a fixed number
 * of days.
 *
 * Pure, and in `api/` rather than `query/` so the browser can import it through its own subpath:
 * the settings card asks the server this question about a person's whole history, and a page asks
 * the same question about the range on screen. Two copies of one rule is how a threshold drifts,
 * so there is one, and `query/sourceActivity.ts` is a database read that ends in a call to this.
 *
 * Measured against a real household archive 2026-09-15: a flat seven day threshold flags 13 of 17
 * sources, because most are apps that reported for two days and stopped, and one manual source
 * has a median gap of 31 days, so any threshold short enough to catch a dead watch calls that
 * scale broken every month.
 */

/** Below this many reporting dates a source has no cadence to be judged against, so it is not. */
export const MIN_REPORTING_DATES = 14

/**
 * How many of its own typical gaps a source may miss before it is stale.
 *
 * Sweeping this from 3 to 6, and the median against the 90th percentile, changed nothing about
 * which sources were flagged in the real archive: the distribution is bimodal, a source is either
 * reporting today or silent for months, so the floors below do the work and this does almost none.
 */
export const STALE_GAP_MULTIPLIER = 4

/** No source is stale before this, however chatty. Thirteen days quiet is not yet news. */
export const STALE_FLOOR_DAYS = 14

/**
 * How long a source with no cadence must be silent before a surface stops listing it as live.
 *
 * The one arbitrary number here. It is a display choice rather than a verdict - such a source is
 * never called stale, because nothing about it supports the claim - and it hides nothing.
 */
export const UNJUDGED_FLOOR_DAYS = 60

export type SourceStatus = 'reporting' | 'stale' | 'unjudged'

export interface SourceCadence {
  /** The last date in the input, null when there were none. */
  lastReportedDate: string | null
  /** Distinct dates, so the same day arriving twice counts once. */
  reportingDates: number
  /** Median gap between consecutive reporting dates, in days; null below two dates. */
  medianGapDays: number | null
  status: SourceStatus
  /** Whether a surface lists this source among the live ones. See UNJUDGED_FLOOR_DAYS. */
  reportingNow: boolean
}

const DAY_MS = 86_400_000

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)

/**
 * `dates` need be neither sorted nor deduplicated. The database read hands them over sorted and
 * distinct; a caller assembling them from a chart's points has neither guarantee, and a
 * last-reported date read off an unsorted array is wrong silently rather than loudly.
 *
 * `asOf` is whatever the caller is judging against: today for the settings card, the last day of
 * the range on screen for a chart, which is what makes "stopped inside this range" the same
 * question as "stopped" asked over a shorter history.
 */
export function cadenceOf(dates: readonly string[], asOf: string): SourceCadence {
  const distinct = [...new Set(dates)].sort()
  if (distinct.length === 0) {
    return {
      lastReportedDate: null, reportingDates: 0, medianGapDays: null,
      status: 'unjudged', reportingNow: false,
    }
  }

  const last = distinct[distinct.length - 1]!
  const silent = daysBetween(last, asOf)
  const gaps = distinct.slice(1).map((date, i) => daysBetween(distinct[i]!, date)).sort((a, b) => a - b)
  // Floored at 1: a source reporting once a day has a gap of 1, and a zero would make the
  // threshold below zero too, so every such source would be stale the moment it paused.
  const median = gaps.length === 0 ? null : Math.max(1, gaps[Math.floor(gaps.length / 2)]!)
  const judged = distinct.length >= MIN_REPORTING_DATES && median !== null
  const limit = (floor: number): number => Math.max(STALE_GAP_MULTIPLIER * (median ?? 1), floor)
  const status: SourceStatus = judged
    ? (silent > limit(STALE_FLOOR_DAYS) ? 'stale' : 'reporting')
    : 'unjudged'

  return {
    lastReportedDate: last,
    reportingDates: distinct.length,
    medianGapDays: median,
    status,
    reportingNow: status === 'stale'
      ? false
      : silent <= limit(judged ? STALE_FLOOR_DAYS : UNJUDGED_FLOOR_DAYS),
  }
}
