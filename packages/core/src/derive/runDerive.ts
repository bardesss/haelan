import { and, eq, gte, lte, ne } from 'drizzle-orm'
import type { Database } from '../db/open.ts'
import type { DeriveQueue } from '../store/deriveQueue.ts'
import { daily, samples } from '../db/schema/index.ts'
import { rollUpDay, PROVIDER_SOURCE } from './rollup.ts'
import type { SampleLike } from './rollup.ts'
import { localDateOf } from './localDay.ts'

const DEFAULT_BATCH = 64
const HOUR_MS = 3_600_000

export interface DeriveReport { daysDerived: number, rowsWritten: number }

/**
 * Drains the dirty day queue. One transaction per day: a day's rows are replaced wholesale, so
 * a metric whose samples were all excluded loses its row rather than keeping a stale number.
 *
 * The queue entry is cleared inside the same transaction as the rows it produced. A crash
 * between the two would otherwise leave a day that looks derived and is not.
 */
export function runDerive(input: { db: Database, queue: DeriveQueue, batch?: number }): DeriveReport {
  const claimed = input.queue.claim(input.batch ?? DEFAULT_BATCH)
  let rowsWritten = 0

  for (const entry of claimed) {
    input.db.transaction((tx) => {
      // A person can carry years of samples, so scanning every row of their history per queued
      // day is not an option: the spec puts sample volume at roughly 3.2 million rows a year.
      // The provider API can report offsets from UTC-12 to UTC+14, so a local day's instants can
      // land up to 14 hours either side of its UTC midnight. Widen the query by that much, then
      // apply the exact per-row filter below: the result is identical to an unbounded scan, only
      // the number of rows read to get there changes.
      const utcMidnight = Date.parse(`${entry.localDate}T00:00:00Z`)
      const windowStart = utcMidnight - 14 * HOUR_MS
      const windowEnd = utcMidnight + 38 * HOUR_MS

      const dayRows = tx.select().from(samples).where(and(
        eq(samples.personId, entry.personId),
        gte(samples.utcMs, windowStart),
        lte(samples.utcMs, windowEnd),
      )).all()
        .filter((row) => localDateOf(row.utcMs, row.tzOffsetMinutes) === entry.localDate)

      const derived = rollUpDay({
        personId: entry.personId,
        localDate: entry.localDate,
        rows: dayRows as SampleLike[],
      })

      // Everything we derive for this day goes, then comes back. Provider rows are excluded
      // because they are ingested rather than derived and nothing here could recompute them.
      tx.delete(daily).where(and(
        eq(daily.personId, entry.personId),
        eq(daily.localDate, entry.localDate),
        ne(daily.source, PROVIDER_SOURCE),
      )).run()

      for (const row of derived) tx.insert(daily).values(row).run()
      rowsWritten += derived.length

      input.queue.clear([entry], tx)
    })
  }

  return { daysDerived: claimed.length, rowsWritten }
}
