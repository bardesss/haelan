// Fastest efforts from GPS (M10b PR 6, D7): the quickest a workout covered a kilometre, a mile and
// five kilometres anywhere inside it, read off the route's own timed fixes. Splits only ever say
// how long each whole kilometre from the start took; this finds the fastest stretch wherever it
// began.
import { haversineMeters } from '../query/workoutThrough.ts'

export const EFFORT_DISTANCES = { km: 1000, mile: 1609.344, fiveK: 5000 } as const
export type EffortKey = keyof typeof EFFORT_DISTANCES

/** One fastest effort: its seconds, and how far into the route (metres along it) it began. */
export interface Effort { seconds: number, fromMeters: number }

/**
 * Fastest elapsed seconds covering each distance, from cumulative haversine distance over timed
 * fixes, two pointers with linear interpolation at the window's start; null for a distance longer
 * than the route. Each carries where along the route its window began, so a page can say where
 * in the run the stretch lay (a distance, never a coordinate).
 *
 * Each window ends on a fix and starts exactly the distance back along the route, the instant
 * there read between the two fixes either side as if the stretch between them were run evenly.
 * Without that, a window would start on the fix before and cover more than the distance, so every
 * effort would read slow by up to one fix's worth of time.
 */
export function fastestEffortsAlong(points: readonly { atMs: number, latitude: number, longitude: number }[]): Record<EffortKey, Effort | null> {
  const fixes = [...points].sort((a, b) => a.atMs - b.atMs)
  const cumulative = [0]
  for (let i = 1; i < fixes.length; i += 1) cumulative.push(cumulative[i - 1]! + haversineMeters(fixes[i - 1]!, fixes[i]!))
  const effort = (distance: number): Effort | null => {
    let best: Effort | null = null
    let start = 0
    for (let end = 1; end < fixes.length; end += 1) {
      const from = cumulative[end]! - distance
      if (from < 0) continue
      // The start pointer only moves forward: `from` grows with `end`.
      while (cumulative[start + 1]! <= from) start += 1
      const span = cumulative[start + 1]! - cumulative[start]!
      const t = span === 0 ? 0 : (from - cumulative[start]!) / span
      const fromMs = fixes[start]!.atMs + (fixes[start + 1]!.atMs - fixes[start]!.atMs) * t
      const seconds = (fixes[end]!.atMs - fromMs) / 1000
      if (best === null || seconds < best.seconds) best = { seconds, fromMeters: from }
    }
    return best
  }
  return { km: effort(EFFORT_DISTANCES.km), mile: effort(EFFORT_DISTANCES.mile), fiveK: effort(EFFORT_DISTANCES.fiveK) }
}

/** fastestEffortsAlong's seconds alone, the shape Records and the route summaries keep. */
export function fastestEfforts(points: readonly { atMs: number, latitude: number, longitude: number }[]): Record<EffortKey, number | null> {
  const along = fastestEffortsAlong(points)
  return { km: along.km?.seconds ?? null, mile: along.mile?.seconds ?? null, fiveK: along.fiveK?.seconds ?? null }
}
