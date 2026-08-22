import { and, eq, gte, lte, ne } from 'drizzle-orm'
import type { Database } from '../db/open.ts'
import type { DeriveQueue } from '../store/deriveQueue.ts'
import type { SourcePriorityStore } from '../store/sourcePriority.ts'
import type { OverrideStore } from '../store/overrides.ts'
import { daily, samples } from '../db/schema/index.ts'
import { rollUpDay, PROVIDER_SOURCE } from './rollup.ts'
import type { SampleLike } from './rollup.ts'
import { mergeDay } from './merge.ts'
import type { Priority } from './priority.ts'
import { localDateOf } from './localDay.ts'
import { applyToDay, applyToSamples, excludedMetrics } from './overrides.ts'
import type { OverrideLike } from './overrides.ts'

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
export function runDerive(input: {
  db: Database
  queue: DeriveQueue
  priority: SourcePriorityStore
  overrides: OverrideStore
  batch?: number
}): DeriveReport {
  const claimed = input.queue.claim(input.batch ?? DEFAULT_BATCH)
  let rowsWritten = 0

  // One load per person rather than per day: draining a year of backfill is 365 entries for the
  // same person. A ranking that changes underneath the drain costs a re-derive rather than a
  // wrong row, because a priority write marks the days dirty again.
  const priorities = new Map<string, Priority>()
  const priorityFor = (personId: string): Priority => {
    const cached = priorities.get(personId)
    if (cached) return cached
    const loaded = input.priority.load(personId)
    priorities.set(personId, loaded)
    return loaded
  }

  const overridesByPerson = new Map<string, OverrideLike[]>()
  const overridesFor = (personId: string): OverrideLike[] => {
    const cached = overridesByPerson.get(personId)
    if (cached) return cached
    const loaded = input.overrides.listFor(personId)
    overridesByPerson.set(personId, loaded)
    return loaded
  }

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

      const personOverrides = overridesFor(entry.personId)
      // Before aggregation, so an excluded reading is absent from the mean rather than removed
      // from it afterwards, and so an hour whose only reading was excluded is not an hour won.
      const kept = applyToSamples(dayRows as SampleLike[], personOverrides)

      const derived = rollUpDay({
        personId: entry.personId,
        localDate: entry.localDate,
        rows: kept,
      })
      const merged = mergeDay({
        personId: entry.personId,
        localDate: entry.localDate,
        rows: kept,
        priority: priorityFor(entry.personId),
      })

      const excluded = excludedMetrics(personOverrides, entry.localDate)
      const rows = applyToDay([...derived, ...merged], excluded)

      // Everything we derive for this day goes, then comes back. Provider rows are excluded
      // because they are ingested rather than derived and nothing here could recompute them.
      tx.delete(daily).where(and(
        eq(daily.personId, entry.personId),
        eq(daily.localDate, entry.localDate),
        ne(daily.source, PROVIDER_SOURCE),
      )).run()

      // A day_metric exclusion reaches the provider rows too, which the delete above spares.
      // Google's own reconciliation is still a number for the day somebody threw out, and it is
      // rewritten by the next sync of that metric, which requeues the day and lands back here.
      for (const metric of excluded) {
        tx.delete(daily).where(and(
          eq(daily.personId, entry.personId),
          eq(daily.localDate, entry.localDate),
          eq(daily.metric, metric),
        )).run()
      }

      for (const row of rows) tx.insert(daily).values(row).run()
      rowsWritten += rows.length

      input.queue.clear([entry], tx)
    })
  }

  return { daysDerived: claimed.length, rowsWritten }
}
