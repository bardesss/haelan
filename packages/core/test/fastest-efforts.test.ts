import { describe, expect, it } from 'vitest'
import { EFFORT_DISTANCES, fastestEfforts } from '../src/api/fastestEfforts.ts'

const METRES_PER_DEGREE = (6_371_000 * Math.PI) / 180
const START = Date.parse('2026-09-01T07:00:00Z')

/** Fixes due north every 10 s, each leg's speed in m/s for its count of fixes. */
function run(legs: readonly { speed: number, fixes: number }[]) {
  const points = [{ atMs: START, latitude: 52, longitude: 5 }]
  let metres = 0
  let ms = START
  for (const leg of legs) {
    for (let i = 0; i < leg.fixes; i += 1) {
      metres += leg.speed * 10
      ms += 10_000
      points.push({ atMs: ms, latitude: 52 + metres / METRES_PER_DEGREE, longitude: 5 })
    }
  }
  return points
}

describe('fastestEfforts', () => {
  it('reads each distance off an even 3 m/s run, interpolating where a window starts between fixes', () => {
    // 200 legs of 30 m: 6 km. A kilometre is 33 1/3 legs, so without interpolation it reads 340 s.
    const efforts = fastestEfforts(run([{ speed: 3, fixes: 200 }]))
    expect(efforts.km).toBeCloseTo(1000 / 3, 1)
    expect(efforts.mile).toBeCloseTo(536.4, 1)
    expect(efforts.fiveK).toBeCloseTo(5000 / 3, 1)
  })

  it('finds the fastest kilometre inside a longer run', () => {
    // 1500 m at 3 m/s, 1000 m at 4 m/s, 1500 m at 3 m/s.
    const efforts = fastestEfforts(run([{ speed: 3, fixes: 50 }, { speed: 4, fixes: 25 }, { speed: 3, fixes: 50 }]))
    expect(efforts.km).toBeCloseTo(250, 6)
  })

  it('reads the fixes in time order, whatever order they arrive in', () => {
    expect(fastestEfforts([...run([{ speed: 3, fixes: 200 }])].reverse()).km).toBeCloseTo(1000 / 3, 1)
  })

  it('answers null for every distance longer than the route', () => {
    expect(fastestEfforts(run([{ speed: 3, fixes: 30 }]))).toEqual({ km: null, mile: null, fiveK: null })
    expect(fastestEfforts(run([{ speed: 3, fixes: 40 }]))).toMatchObject({ mile: null, fiveK: null })
    expect(fastestEfforts([])).toEqual({ km: null, mile: null, fiveK: null })
  })

  it('reads a kilometre off a route barely longer than one', () => {
    expect(fastestEfforts(run([{ speed: 4, fixes: 26 }])).km).toBeCloseTo(250, 6)
  })

  it('names the three distances the spec names', () => {
    expect(EFFORT_DISTANCES).toEqual({ km: 1000, mile: 1609.344, fiveK: 5000 })
  })
})
