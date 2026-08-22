import { localHourOf } from './localDay.ts'

const HOURS_IN_DAY = 24

/**
 * The fraction of the local day's hours carrying at least one sample.
 *
 * Hours rather than samples, because a rate would need a declared expected frequency per metric
 * and would be meaningless for anything episodic. Hours mean the same thing for heart rate at
 * one reading a minute and for weight at one a week: how much of the day was observed.
 *
 * Callers pass the rows for one person, one metric, one source and one local day. Rows from
 * another day would count hours that are not this day's.
 */
export function coverageOf(rows: ReadonlyArray<{ utcMs: number, tzOffsetMinutes: number }>): number {
  const hours = new Set<number>()
  for (const row of rows) hours.add(localHourOf(row.utcMs, row.tzOffsetMinutes))
  return hours.size / HOURS_IN_DAY
}
