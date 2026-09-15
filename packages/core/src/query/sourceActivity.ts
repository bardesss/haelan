import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'

/**
 * Whether each of a person's sources is still reporting, judged against its OWN cadence.
 *
 * Measured 2026-09-15 against a real household archive, which is why this is not a threshold in
 * days: a flat seven day rule flags 13 of 17 sources there, because most are apps that reported
 * for two days and stopped. One manual source has a median gap of 31 days, so any threshold short
 * enough to catch a dead watch calls that scale broken every month. Judging a source against its
 * own habit answers both, and judging only sources that HAVE a habit keeps the one-offs out of it.
 *
 * Reads `daily`, never `samples`. The same question costs 3,380 ms against 2.18M sample rows and
 * 23 ms against 29,676 daily rows, because `samples` is indexed (person_ref, metric_ref, utc_ms)
 * and a grouped scan by source therefore reads all of it. `daily` is also a strict superset for
 * this question - measured: every source with samples has daily rows, and one source had daily
 * rows and no samples - and its local dates are the right grain, since "did this source report
 * that day" is a question about the household's day rather than a UTC bucket.
 *
 * Nothing is stored. Computed on read, so no DERIVATION_VERSION moves and no upgrade owes a
 * rebuild - which matters because the boot rebuild holds SQLite's write lock for its whole run.
 *
 * Per CONTRIBUTING.md's rule for a reader whose output is printed:
 *
 * - **Session kinds:** none. This reads `daily` rows, not sessions.
 * - **Override actions:** NEITHER, deliberately, and this is the one place in this codebase where
 *   ignoring an exclusion is the correct answer. A day the reader excluded is still a day the
 *   source reported on: staleness is a question about the device, not about the data's quality,
 *   and a household that excluded a bad week must not thereby be told its watch has died.
 * - **Thinned:** no. It reads dates, never a point budget.
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
 * How long a source with no cadence must be silent before the surfaces stop listing it as live.
 *
 * The one arbitrary number here. It is a display choice rather than a verdict - such a source is
 * never called stale, because nothing about it supports the claim - and it hides nothing.
 */
export const UNJUDGED_FLOOR_DAYS = 60

export type SourceStatus = 'reporting' | 'stale' | 'unjudged'

export interface SourceActivity {
  sourceId: string
  /** Local date, null when the source has no daily row at all. */
  lastReportedDate: string | null
  /** Distinct local dates carrying any row for this source. */
  reportingDates: number
  /** Median gap between consecutive reporting dates, in days; null below two dates. */
  medianGapDays: number | null
  status: SourceStatus
  /**
   * Whether the surfaces list this source among the live ones. Returned rather than derived by
   * each caller: the Settings card would otherwise carry its own copy of UNJUDGED_FLOOR_DAYS, and
   * two copies of one threshold in two files is how a rule drifts.
   */
  reportingNow: boolean
}

const DAY_MS = 86_400_000

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)

export function readSourceActivity(
  db: DbOrTx, personId: string, input: { today: string },
): SourceActivity[] {
  // 'merged' and 'provider' are written by derivation itself rather than by a device, so they
  // cannot go stale and reporting them as sources would be a category error.
  const rows = db.all<{ source: string, localDate: string }>(sql`
    SELECT DISTINCT source, local_date AS localDate FROM daily
     WHERE person_id = ${personId} AND source NOT IN ('merged', 'provider')
     ORDER BY source, local_date`)

  const bySource = new Map<string, string[]>()
  for (const row of rows) {
    const dates = bySource.get(row.source)
    if (dates) dates.push(row.localDate)
    else bySource.set(row.source, [row.localDate])
  }

  return [...bySource].map(([sourceId, dates]) => {
    const last = dates[dates.length - 1]!
    const silent = daysBetween(last, input.today)
    const gaps = dates.slice(1).map((date, i) => daysBetween(dates[i]!, date)).sort((a, b) => a - b)
    // Floored at 1: a source reporting once a day has a gap of 1, and a zero would make the
    // threshold below zero too, so every such source would be stale the moment it paused.
    const median = gaps.length === 0 ? null : Math.max(1, gaps[Math.floor(gaps.length / 2)]!)
    const judged = dates.length >= MIN_REPORTING_DATES && median !== null
    const limit = (floor: number): number => Math.max(STALE_GAP_MULTIPLIER * (median ?? 1), floor)
    const status: SourceStatus = judged
      ? (silent > limit(STALE_FLOOR_DAYS) ? 'stale' : 'reporting')
      : 'unjudged'

    return {
      sourceId,
      lastReportedDate: last,
      reportingDates: dates.length,
      medianGapDays: median,
      status,
      reportingNow: status === 'stale'
        ? false
        : silent <= limit(judged ? STALE_FLOOR_DAYS : UNJUDGED_FLOOR_DAYS),
    }
  })
}
