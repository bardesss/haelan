import { describe, expect, it } from 'vitest'
import { ROUTE_DISTANCE_TOLERANCE, ROUTE_MATCH_METERS, routeSignature, sameRoute } from '../src/api/routeMatch.ts'
import type { RouteSignature } from '../src/api/routeMatch.ts'

const METRES_PER_DEGREE = (6_371_000 * Math.PI) / 180
const LAT = 52
const LON = 5
const lonMetres = METRES_PER_DEGREE * Math.cos((LAT * Math.PI) / 180)

/** A point `east` and `north` metres from the origin. */
const at = (east: number, north: number) => ({ latitude: LAT + north / METRES_PER_DEGREE, longitude: LON + east / lonMetres })

/** A square loop of `side` metres run anticlockwise: east, north, west, south, a point every 10 m. */
function loop(side: number) {
  const points = []
  const legs: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  let x = 0
  let y = 0
  points.push(at(x, y))
  for (const [dx, dy] of legs) {
    for (let i = 0; i < side / 10; i += 1) {
      x += dx * 10
      y += dy * 10
      points.push(at(x, y))
    }
  }
  return points
}

/** A signature with one of its points moved `north` metres. */
const moved = (s: RouteSignature, key: 'start' | 'end' | 'quarter', north: number): RouteSignature => ({
  ...s, [key]: { latitude: s[key].latitude + north / METRES_PER_DEGREE, longitude: s[key].longitude },
})

describe('routeSignature', () => {
  it('has no signature below two points', () => {
    expect(routeSignature([])).toBeNull()
    expect(routeSignature([at(0, 0)])).toBeNull()
  })

  it('reads the start, the end, the distance and the point a quarter of the way along', () => {
    const s = routeSignature(loop(500))!
    expect(s.distanceMeters).toBeCloseTo(2000, 0)
    expect(s.start).toEqual(at(0, 0))
    expect(s.end.latitude).toBeCloseTo(LAT, 9)
    // A quarter of 2 km is the far end of the first 500 m leg, east of the start.
    expect(s.quarter.latitude).toBeCloseTo(at(500, 0).latitude, 5)
    expect(s.quarter.longitude).toBeCloseTo(at(500, 0).longitude, 5)
  })

  it('interpolates the quarter point between two fixes', () => {
    const s = routeSignature([at(0, 0), at(0, 1000)])!
    expect(s.quarter.latitude).toBeCloseTo(at(0, 250).latitude, 9)
  })
})

describe('sameRoute', () => {
  it('matches a loop against itself', () => {
    const s = routeSignature(loop(500))!
    expect(sameRoute(s, s)).toBe(true)
  })

  it('does not match the same loop run the other way', () => {
    expect(sameRoute(routeSignature(loop(500))!, routeSignature([...loop(500)].reverse())!)).toBe(false)
  })

  it('does not match a route 20% longer, and does match one 5% longer', () => {
    const base = routeSignature(loop(500))!
    expect(sameRoute(base, routeSignature(loop(600))!)).toBe(false)
    expect(sameRoute(base, { ...base, distanceMeters: base.distanceMeters * 1.05 })).toBe(true)
    expect(sameRoute({ ...base, distanceMeters: base.distanceMeters * 1.2 }, base)).toBe(false)
  })

  it('does not match a start or an end 200 m away, and does match one 140 m away', () => {
    const base = routeSignature(loop(500))!
    expect(sameRoute(base, moved(base, 'start', 200))).toBe(false)
    expect(sameRoute(base, moved(base, 'start', 140))).toBe(true)
    expect(sameRoute(base, moved(base, 'end', 200))).toBe(false)
    expect(sameRoute(base, moved(base, 'end', 140))).toBe(true)
    expect(sameRoute(base, moved(base, 'quarter', 200))).toBe(false)
    expect(sameRoute(base, moved(base, 'quarter', 140))).toBe(true)
  })

  it('has the thresholds the spec names', () => {
    expect([ROUTE_MATCH_METERS, ROUTE_DISTANCE_TOLERANCE]).toEqual([150, 0.1])
  })
})
