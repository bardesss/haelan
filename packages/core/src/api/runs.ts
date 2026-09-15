export interface Run { from: string, to: string, days: number }

/**
 * Shorter than this reads as a week's coincidence rather than a habit worth naming.
 *
 * A proposal rather than a derived truth, and the one arbitrary number in this feature. It is a
 * named constant so the next person can argue with a number instead of hunting a literal.
 */
export const MIN_RUN_DAYS = 7

const DAY_MS = 86_400_000

/**
 * The longest unbroken run of consecutive dates, or null below `minDays`.
 *
 * **Consecutive dates carrying a reading, not consecutive days above a goal**, and that was the
 * design's one real reversal. A threshold streak is the obvious shape and the household archive
 * makes it embarrassing: the longest run at or above 10,000 steps is two days, at 8,000 it is
 * six, at 5,000 it is eleven. The longest run of days the archive simply HAS a reading for is
 * 159, and the longest run of tracked nights is 81. That number needs no threshold chosen on
 * somebody's behalf, and it measures the thing this milestone is about - whether the mirror is
 * complete - rather than whether its owner met a step goal somebody else picked.
 *
 * Dates need be neither sorted nor distinct: the reader gathers them per metric per day, so the
 * same date arrives once per metric, and counted twice a run would measure longer than the
 * calendar allows.
 */
export function longestRun(dates: readonly string[], minDays: number): Run | null {
  const distinct = [...new Set(dates)].sort()
  if (distinct.length === 0) return null

  // Parsed as UTC midnights rather than local: Europe/Amsterdam's spring forward makes one local
  // day 23 hours long, and arithmetic in local time would read the dates either side of it as
  // non-consecutive. A civil date here is a label, not an instant.
  const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS

  let best: Run | null = null
  let startAt = 0
  for (let at = 0; at <= distinct.length; at += 1) {
    const broken = at === distinct.length
      || dayNumber(distinct[at]!) !== dayNumber(distinct[at - 1]!) + 1
    if (at > 0 && broken) {
      const days = at - startAt
      if (best === null || days > best.days) {
        best = { from: distinct[startAt]!, to: distinct[at - 1]!, days }
      }
      startAt = at
    }
  }

  return best !== null && best.days >= minDays ? best : null
}
