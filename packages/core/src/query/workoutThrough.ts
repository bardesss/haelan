import type { ExerciseCategory } from '../api/exerciseCategory.ts'

// The workout page's minute series beside its heart rate trace (M10b): pace (or a ride's speed)
// from the GPS route's own timestamps, cadence from the steps rows. Pure functions over rows the page has already read,
// on the same elapsed axis the trace is drawn on, so the three rows line up minute for minute.

export interface MinuteSeries { unit: string, points: { elapsedSeconds: number, value: number }[] }

/** Pace, with its fastest minute: the lowest smoothed seconds per km and when it came. */
export interface PaceSeries extends MinuteSeries { fastest: { secondsPerKm: number, elapsedSeconds: number } | null }

/** A ride's speed in metres per second, with its fastest minute: the highest smoothed speed and when it came. */
export interface SpeedSeries extends MinuteSeries { fastest: { metersPerSecond: number, elapsedSeconds: number } | null }

const MINUTE_MS = 60_000
const EARTH_RADIUS_METRES = 6_371_000
/**
 * Less than this in a full minute is standing still or GPS drift, not a pace worth drawing: set by
 * the category, since a slow walk covers less than a slow run and a ride freewheeling at a light
 * covers more. A category without its own reads as a run.
 */
const PAUSE_METRES_PER_MINUTE: Partial<Record<ExerciseCategory, number>> = { walk: 20, run: 50, ride: 150 }
const DEFAULT_PAUSE_METRES_PER_MINUTE = 50

/** The metres a minute under which the category counts as standing still (PAUSE_METRES_PER_MINUTE). */
export function pauseMetresPerMinuteOf(category: ExerciseCategory): number {
  return PAUSE_METRES_PER_MINUTE[category] ?? DEFAULT_PAUSE_METRES_PER_MINUTE
}
/** Steps rows spaced further apart than this each cover several minutes, and no per-minute cadence can be read off them. */
const CADENCE_MAX_SPACING_MS = 60_000

/** The great-circle distance between two fixes, in metres. Shared with route matching and fastest efforts. */
export function haversineMeters(a: { latitude: number, longitude: number }, b: { latitude: number, longitude: number }): number {
  const rad = Math.PI / 180
  const dLat = (b.latitude - a.latitude) * rad
  const dLon = (b.longitude - a.longitude) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)))
}

// Answers: each minute's value as the mean of itself and whichever of its two neighbours have one,
// oldest first. A gap stays a gap; it is only left out of its neighbours' means.
function smoothed(byMinute: ReadonlyMap<number, number>, unit: string): MinuteSeries | null {
  const minutes = [...byMinute.keys()].sort((a, b) => a - b)
  if (minutes.length === 0) return null
  return {
    unit,
    points: minutes.map((m) => {
      const around = [m - 1, m, m + 1].flatMap((n) => { const v = byMinute.get(n); return v === undefined ? [] : [v] })
      return { elapsedSeconds: m * 60, value: around.reduce((sum, v) => sum + v, 0) / around.length }
    }),
  }
}

/**
 * Pace in seconds per km per elapsed minute from timed route points: distance by haversine between
 * fixes, a minute's pace = 60 / km covered in that minute, smoothed by a 3-minute centred mean;
 * minutes under `pauseMetres` (50 m unless the category sets its own, pauseMetresPerMinuteOf) are
 * gaps. Null with fewer than 2 fixes.
 *
 * A stretch between two fixes is spread evenly over the time between them, so one that crosses a
 * minute boundary counts in both minutes for its share. A minute the fixes only partly span (the
 * last one, or one side of a dropout) is read over the seconds they do span, the threshold scaled
 * to match, rather than as a whole minute that went slowly. A stretch slower than the threshold
 * counts for nothing at all, neither its metres nor its seconds: a pause is left out of the minutes
 * it touches, so the minute the run resumed in reads the pace it resumed at, and a minute that was
 * all pause is a gap. Null too when no minute qualifies.
 * Fixes outside [startMs, endMs) count for nothing, so pace never runs past the trace's own axis.
 * `fastest` is the minute with the lowest smoothed pace, the earlier of a tie.
 */
export function paceSeries(
  route: readonly { atMs: number, latitude: number, longitude: number }[], startMs: number, endMs: number,
  pauseMetres: number = DEFAULT_PAUSE_METRES_PER_MINUTE,
): PaceSeries | null {
  const pace = new Map<number, number>()
  for (const [minute, { metres, seconds }] of movingMinutes(route, startMs, endMs, pauseMetres)) pace.set(minute, seconds / (metres / 1000))
  const series = smoothed(pace, 'seconds_per_km')
  if (series === null) return null
  // The first of the lowest, so a tie names the earlier minute. A series has at least one point.
  const fastest = series.points.reduce((best, p) => (p.value < best.value ? p : best), series.points[0]!)
  return { ...series, fastest: { secondsPerKm: fastest.value, elapsedSeconds: fastest.elapsedSeconds } }
}

/**
 * A ride's speed in metres per second per elapsed minute: the same minutes paceSeries reads, by the
 * same rules (a pause under `pauseMetres` a minute left out, a part minute read over the seconds it
 * spans), each read as metres over seconds rather than seconds over kilometres, and smoothed the
 * same way. `fastest` is the minute with the highest smoothed speed, the earlier of a tie.
 */
export function speedSeries(
  route: readonly { atMs: number, latitude: number, longitude: number }[], startMs: number, endMs: number,
  pauseMetres: number = DEFAULT_PAUSE_METRES_PER_MINUTE,
): SpeedSeries | null {
  const speed = new Map<number, number>()
  for (const [minute, { metres, seconds }] of movingMinutes(route, startMs, endMs, pauseMetres)) speed.set(minute, metres / seconds)
  const series = smoothed(speed, 'meters_per_second')
  if (series === null) return null
  const fastest = series.points.reduce((best, p) => (p.value > best.value ? p : best), series.points[0]!)
  return { ...series, fastest: { metersPerSecond: fastest.value, elapsedSeconds: fastest.elapsedSeconds } }
}

// Answers: the metres covered and the seconds spanned in each elapsed minute that moved, the
// minutes paceSeries and speedSeries both read (paceSeries says the rules).
function movingMinutes(
  route: readonly { atMs: number, latitude: number, longitude: number }[], startMs: number, endMs: number, pauseMetres: number,
): Map<number, { metres: number, seconds: number }> {
  const fixes = [...route].sort((a, b) => a.atMs - b.atMs)
  const metres = new Map<number, number>()
  const covered = new Map<number, number>()
  for (let i = 1; i < fixes.length; i += 1) {
    const a = fixes[i - 1]!
    const b = fixes[i]!
    const span = b.atMs - a.atMs
    if (span <= 0) continue
    const distance = haversineMeters(a, b)
    // Slower than the gap's own rate is standing still: a pause the phone logged as one long
    // stretch, which spread evenly would read as a slow minute on either side of it.
    if (distance < pauseMetres * (span / MINUTE_MS)) continue
    const until = Math.min(b.atMs, endMs)
    let from = Math.max(a.atMs, startMs)
    while (from < until) {
      const minute = Math.floor((from - startMs) / MINUTE_MS)
      const to = Math.min(until, startMs + (minute + 1) * MINUTE_MS)
      metres.set(minute, (metres.get(minute) ?? 0) + distance * ((to - from) / span))
      covered.set(minute, (covered.get(minute) ?? 0) + (to - from) / 1000)
      from = to
    }
  }
  const moving = new Map<number, { metres: number, seconds: number }>()
  for (const [minute, seconds] of covered) {
    const m = metres.get(minute) ?? 0
    if (m < pauseMetres * (seconds / 60)) continue
    moving.set(minute, { metres: m, seconds })
  }
  return moving
}

/**
 * Steps per minute from raw step rows inside the workout, only when their median spacing is ≤ 60 s;
 * smoothed by a 3-minute centred mean. Null otherwise.
 *
 * Steps are stored as provider intervals keyed by their start, the end dropped at mapping, so a row
 * is a minute's steps only when the rows come a minute apart or closer. Rows longer than that are
 * refused outright rather than spread: where the interval ended is not stored.
 *
 * Minutes are wall-clock minutes, elapsed counted from the minute the workout started in: the
 * window read keys a minute of several rows on the minute's start and a minute of one row on the
 * row's own instant, so only the minute floor puts both in the same bucket. A row counts when its
 * minute is the start's minute or later and it came before the end.
 */
export function cadenceSeries(rows: readonly { utcMs: number, value: number }[], startMs: number, endMs: number): MinuteSeries | null {
  const startMinute = Math.floor(startMs / MINUTE_MS)
  const inside = rows.filter((r) => Math.floor(r.utcMs / MINUTE_MS) >= startMinute && r.utcMs < endMs).sort((a, b) => a.utcMs - b.utcMs)
  if (inside.length < 2) return null
  const spacings = inside.slice(1).map((r, i) => r.utcMs - inside[i]!.utcMs).sort((a, b) => a - b)
  const mid = Math.floor(spacings.length / 2)
  const median = spacings.length % 2 === 1 ? spacings[mid]! : (spacings[mid - 1]! + spacings[mid]!) / 2
  if (median > CADENCE_MAX_SPACING_MS) return null
  const steps = new Map<number, number>()
  for (const r of inside) {
    const minute = Math.floor(r.utcMs / MINUTE_MS) - startMinute
    steps.set(minute, (steps.get(minute) ?? 0) + r.value)
  }
  return smoothed(steps, 'steps_per_minute')
}
