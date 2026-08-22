import { localHourOf } from './localDay.ts'
import { rollUpDay, MERGED_SOURCE } from './rollup.ts'
import type { DailyRow, SampleLike } from './rollup.ts'
import type { Priority } from './priority.ts'

export interface MixEntry {
  source: string
  hours: number
}

export interface MergeDayInput {
  personId: string
  localDate: string
  /** One person, one local day, per source, and already override applied. */
  rows: readonly SampleLike[]
  priority: Priority
}

/**
 * Choosing between sources, per metric, per local hour. Master design section 9: sum within a
 * source, choose between sources, and fill a gap from a lower priority source rather than
 * averaging two devices into a number neither of them measured.
 *
 * The hour is the bucket because coverageOf already partitions the day that way, so a merged
 * row's mix and its coverage describe the same partition rather than two different ones.
 *
 * It decides only which rows survive. The arithmetic stays rollUpDay's, run over the winning
 * rows with their source rewritten, so a merged mean and a per source mean cannot come to
 * disagree about what a mean is.
 */
export function mergeDay(input: MergeDayInput): DailyRow[] {
  // metric -> local hour -> source -> rows
  const byMetric = new Map<string, Map<number, Map<string, SampleLike[]>>>()

  for (const row of input.rows) {
    // A null is a reading the device did not take, so it cannot win an hour. Letting it win
    // would hand the hour to a source that observed nothing and hide the one that did.
    if (row.value === null) continue
    const hour = localHourOf(row.utcMs, row.tzOffsetMinutes)
    let byHour = byMetric.get(row.metric)
    if (!byHour) { byHour = new Map(); byMetric.set(row.metric, byHour) }
    let bySource = byHour.get(hour)
    if (!bySource) { bySource = new Map(); byHour.set(hour, bySource) }
    const bucket = bySource.get(row.sourceId)
    if (bucket) bucket.push(row)
    else bySource.set(row.sourceId, [row])
  }

  const winning: SampleLike[] = []
  const mixes = new Map<string, Map<string, number>>()

  for (const [metric, byHour] of byMetric) {
    const hoursWon = new Map<string, number>()
    for (const bySource of byHour.values()) {
      let winner: string | null = null
      let best = Number.POSITIVE_INFINITY
      for (const source of bySource.keys()) {
        const rank = input.priority.rank(metric, source)
        // The id breaks a tie, so the winner never depends on Map insertion order, which is
        // whatever order the rows happened to arrive in.
        if (rank < best || (rank === best && winner !== null && source < winner)) {
          best = rank
          winner = source
        }
      }
      if (winner === null) continue
      for (const row of bySource.get(winner)!) winning.push({ ...row, sourceId: MERGED_SOURCE })
      hoursWon.set(winner, (hoursWon.get(winner) ?? 0) + 1)
    }
    mixes.set(metric, hoursWon)
  }

  const rows = rollUpDay({ personId: input.personId, localDate: input.localDate, rows: winning })
  return rows.map((row) => ({
    ...row,
    sourceMix: encodeMix([...(mixes.get(row.metric) ?? new Map<string, number>())]
      .map(([source, hours]) => ({ source, hours }))),
  }))
}

/**
 * Hours descending, then source ascending. A stable string matters because M2e's rebuild
 * regenerates these rows, and a reordered mix would read as a changed merge.
 */
export function encodeMix(entries: readonly MixEntry[]): string {
  const ordered = [...entries].sort((a, b) => (
    b.hours - a.hours || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)
  ))
  return JSON.stringify(ordered)
}
