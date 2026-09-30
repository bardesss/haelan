// Same-route matching (M10b PR 6, D6): whether two GPS routes are the same course, so a workout's
// time can be judged against the earlier times on that course rather than against every run of
// its type. Pure, over points the reader already has; nothing here leaves the server, since a
// signature is made of coordinates.
import { haversineMeters } from '../query/workoutThrough.ts'

export interface LatLon { latitude: number, longitude: number }

export interface RouteSignature { start: LatLon, end: LatLon, quarter: LatLon, distanceMeters: number }

export const ROUTE_MATCH_METERS = 150
export const ROUTE_DISTANCE_TOLERANCE = 0.1

/**
 * A route's start, end, length along its fixes, and the point a quarter of the way along it,
 * interpolated between the two fixes either side. Null below two points: one fix is not a course.
 */
export function routeSignature(points: readonly { latitude: number, longitude: number }[]): RouteSignature | null {
  if (points.length < 2) return null
  const cumulative = [0]
  for (let i = 1; i < points.length; i += 1) cumulative.push(cumulative[i - 1]! + haversineMeters(points[i - 1]!, points[i]!))
  const distanceMeters = cumulative.at(-1)!
  const target = distanceMeters / 4
  let i = 1
  while (i < points.length - 1 && cumulative[i]! < target) i += 1
  const a = points[i - 1]!
  const b = points[i]!
  const span = cumulative[i]! - cumulative[i - 1]!
  const t = span === 0 ? 0 : (target - cumulative[i - 1]!) / span
  const lat = (p: { latitude: number, longitude: number }): LatLon => ({ latitude: p.latitude, longitude: p.longitude })
  return {
    start: lat(points[0]!),
    end: lat(points.at(-1)!),
    quarter: { latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t },
    distanceMeters,
  }
}

/**
 * Same route: starts within 150 m, ends within 150 m, distance within 10 %, and the point a
 * quarter of the way along within 150 m (direction — a loop run the other way fails).
 *
 * The 10 % is of the longer of the two, so the answer does not depend on which route is asked first.
 */
export function sameRoute(a: RouteSignature, b: RouteSignature): boolean {
  const near = (x: LatLon, y: LatLon) => haversineMeters(x, y) <= ROUTE_MATCH_METERS
  return near(a.start, b.start)
    && near(a.end, b.end)
    && Math.abs(a.distanceMeters - b.distanceMeters) <= ROUTE_DISTANCE_TOLERANCE * Math.max(a.distanceMeters, b.distanceMeters)
    && near(a.quarter, b.quarter)
}
