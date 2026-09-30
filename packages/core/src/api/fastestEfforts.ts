// Fastest efforts from GPS (M10b PR 6, D7): the quickest a workout covered each of its category's
// distances anywhere inside it, read off the route's own timed fixes. Splits only ever say how long
// each whole kilometre from the start took; this finds the fastest stretch wherever it began.
import { haversineMeters } from '../query/workoutThrough.ts'
import type { ExerciseCategory } from './exerciseCategory.ts'

/** One distance a category's efforts are read over: `key` names it (`fastest-${key}` is its record). */
export interface EffortDistance { key: string, meters: number }

/**
 * The distances each category reads efforts over, shortest first. A run's are the ones runners
 * race; a ride's the ones cyclists time (a 20 km and 40 km time trial, a 100 km day). Walks, swims
 * and the rest have none: a walk's fastest kilometre is nobody's record, and a swim's distances
 * need lap data the route does not carry.
 */
export const EFFORT_DISTANCES_BY_CATEGORY: Partial<Record<ExerciseCategory, readonly EffortDistance[]>> = {
  run: [
    { key: '1k', meters: 1000 },
    { key: 'mile', meters: 1609.344 },
    { key: '5k', meters: 5000 },
    { key: '10k', meters: 10_000 },
    { key: 'half', meters: 21_097.5 },
    { key: 'marathon', meters: 42_195 },
  ],
  ride: [
    { key: '20k', meters: 20_000 },
    { key: '40k', meters: 40_000 },
    { key: '100k', meters: 100_000 },
  ],
}

/** The distances a category reads efforts over; empty for one that reads none. */
export function effortDistancesOf(category: ExerciseCategory): readonly EffortDistance[] {
  return EFFORT_DISTANCES_BY_CATEGORY[category] ?? []
}

/**
 * The fastest leg between two fixes that still counts as moving under the athlete's own power, in
 * m/s, per category. A phone's first fixes, and now and then one mid-workout, jump by tens or
 * hundreds of metres in a second or two; a leg faster than this is one of those jumps. 36 km/h on
 * foot is past any sprint; 90 km/h on a bike is past any descent anybody times.
 */
export const JUMP_SPEED_BY_CATEGORY = { run: 10, walk: 10, ride: 25 } as const

/** The jump speed for a category, on foot's when it names none of its own. */
export function jumpSpeedOf(category: ExerciseCategory): number {
  return (JUMP_SPEED_BY_CATEGORY as Partial<Record<ExerciseCategory, number>>)[category] ?? JUMP_SPEED_BY_CATEGORY.run
}

/** One fastest effort: its seconds, and how far into the route (metres along it) it began. */
export interface Effort { seconds: number, fromMeters: number }

/** Efforts keyed by their distance's `key`, one entry per distance of the category. */
export type Efforts<T> = Record<string, T>

/**
 * Fastest elapsed seconds covering each of the category's distances, from cumulative haversine
 * distance over timed fixes, two pointers with linear interpolation at the window's start; null for
 * a distance longer than the route, and no entries at all for a category with no distances. Each
 * carries where along the route its window began, so a page can say where in the workout the
 * stretch lay (a distance, never a coordinate).
 *
 * Each window ends on a fix and starts exactly the distance back along the route, the instant
 * there read between the two fixes either side as if the stretch between them were covered evenly.
 * Without that, a window would start on the fix before and cover more than the distance, so every
 * effort would read slow by up to one fix's worth of time.
 */
export function fastestEffortsAlong(
  points: readonly { atMs: number, latitude: number, longitude: number }[], category: ExerciseCategory,
): Efforts<Effort | null> {
  const distances = effortDistancesOf(category)
  if (distances.length === 0) return {}
  const jump = jumpSpeedOf(category)
  const fixes = [...points].sort((a, b) => a.atMs - b.atMs)
  const cumulative = [0]
  for (let i = 1; i < fixes.length; i += 1) {
    const metres = haversineMeters(fixes[i - 1]!, fixes[i]!)
    const seconds = (fixes[i]!.atMs - fixes[i - 1]!.atMs) / 1000
    // A leg quicker than the category's jump speed is the GPS jumping, not the athlete: counted, it
    // would cover part of a window for free and could set a record no later one can beat. It adds
    // no distance.
    cumulative.push(cumulative[i - 1]! + (metres > jump * seconds ? 0 : metres))
  }
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
  return Object.fromEntries(distances.map(({ key, meters }) => [key, effort(meters)]))
}

/** fastestEffortsAlong's seconds alone, the shape Records and the route summaries keep. */
export function fastestEfforts(
  points: readonly { atMs: number, latitude: number, longitude: number }[], category: ExerciseCategory,
): Efforts<number | null> {
  return effortSeconds(fastestEffortsAlong(points, category))
}

/** Efforts already found, reduced to their seconds: a page that has them need not walk the route again. */
export function effortSeconds(along: Efforts<Effort | null>): Efforts<number | null> {
  return Object.fromEntries(Object.entries(along).map(([key, effort]) => [key, effort?.seconds ?? null]))
}
