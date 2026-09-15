import { sql } from 'drizzle-orm'
import { cadenceOf } from '../api/sourceCadence.ts'
import type { SourceCadence, SourceStatus } from '../api/sourceCadence.ts'
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
 * - **Override actions:** NEITHER, deliberately, and this is the one place in this codebase where
 *   ignoring an exclusion is the correct answer. A day the reader excluded is still a day the
 *   source reported on: staleness is a question about the device, not about the data's quality,
 *   and a household that excluded a bad week must not thereby be told its watch has died.
 * - **Thinned:** no. It reads dates, never a point budget.
 */

export type { SourceStatus }

export interface SourceActivity extends SourceCadence {
  sourceId: string
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

  return [...bySource].map(([sourceId, dates]) => ({
    sourceId, ...cadenceOf(dates, input.today),
  }))
}
