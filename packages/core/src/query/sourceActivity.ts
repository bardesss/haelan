import { sql } from 'drizzle-orm'
import { cadenceOf, continuedElsewhere, routineWindowStart } from '../api/sourceCadence.ts'
import type { SourceCadence, SourceReport, SourceStatus } from '../api/sourceCadence.ts'
import type { DbOrTx } from '../db/open.ts'

/**
 * Each of a person's sources with its reporting cadence, over their whole history.
 *
 * The rule itself is `api/sourceCadence.ts`, shared with the browser, because a page asks the
 * same question about the range on screen. This file is the database half: which dates each
 * source reported on.
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
 * - **Override actions:** both, applied upstream, and this reader re-applies neither.
 *   `applyToDay` (derive/overrides.ts) filters an excluded metric's rows out before they are
 *   written, so an excluded day has no `daily` row for this to see, and a correction's value is
 *   already in the row.
 *
 *   **This header used to claim the opposite** - that a day the reader excluded is still a day
 *   the source reported on, and that this was the one place in the codebase where ignoring an
 *   exclusion was correct. The intent was sound: a household that excluded a bad week should not
 *   be told its watch has died. The claim was not, because this reader cannot see those rows.
 *   Honouring the intent would mean reading `samples`, which survive an exclusion, and that was
 *   measured at 3,380ms against 23ms - the entire reason this reads `daily`. So an excluded day
 *   does shorten a source's apparent history here. The effect on a cadence judged over at least
 *   14 reporting dates is marginal, and no household in this project has excluded anything.
 * - **Thinned:** no. It reads dates, never a point budget.
 */

export type { SourceStatus }

export interface SourceActivity extends SourceCadence {
  sourceId: string
  /**
   * A stale source whose routine metrics have all gone on arriving from other sources since
   * (api/sourceCadence.ts's `continuedElsewhere`): a device the provider renamed, or whose data
   * moved to another path. Always false for a source that is not stale.
   *
   * A separate field rather than a fourth status, because `stale` stays true of the id - it did
   * stop, and the settings card and describe_person say so - while the thing a card warns about,
   * data the reader is no longer getting, is not. So every surface that WARNS skips these, and
   * every surface that LISTS still reports the id as stopped.
   */
  continuedElsewhere: boolean
}

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

  const activities = [...bySource].map(([sourceId, dates]) => ({
    sourceId, ...cadenceOf(dates, input.today), continuedElsewhere: false,
  }))

  // Only stale sources are asked whether they carried on, so a household with none pays nothing
  // beyond the read above.
  const stale = activities.filter((a) => a.status === 'stale' && a.lastReportedDate !== null)
  if (stale.length === 0) return activities

  // Of every other source, only whether it reported a metric after a given date matters, so each
  // (source, metric) pair's latest date stands in for all its rows. Measured against a real
  // archive with a source stale for months: a few dozen times fewer rows, in about a third of the
  // time, than reading the distinct (source, date, metric) rows over the same span. One read
  // serves every stale source, from the earliest routine window any of them needs, on the (person_id,
  // local_date, ...) unique index.
  const from = stale.map((a) => routineWindowStart(a.lastReportedDate!)).sort()[0]!
  const latest = db.all<SourceReport>(sql`
    SELECT source, metric, MAX(local_date) AS date FROM daily
     WHERE person_id = ${personId} AND local_date >= ${from} AND source NOT IN ('merged', 'provider')
     GROUP BY source, metric`)
  for (const activity of stale) {
    // The stale source's own final week does need every date, since "routine" counts them. Seven
    // days of one source on the same index.
    const own = db.all<{ date: string, metric: string }>(sql`
      SELECT DISTINCT local_date AS date, metric FROM daily
       WHERE person_id = ${personId} AND source = ${activity.sourceId}
         AND local_date BETWEEN ${routineWindowStart(activity.lastReportedDate!)} AND ${activity.lastReportedDate!}`)
    activity.continuedElsewhere = continuedElsewhere(activity.sourceId, activity.lastReportedDate!, [
      ...own.map((row) => ({ source: activity.sourceId, ...row })),
      ...latest.filter((row) => row.source !== activity.sourceId),
    ])
  }
  return activities
}
