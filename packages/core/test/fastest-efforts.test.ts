import { describe, expect, it } from 'vitest'
import { EFFORT_DISTANCES_BY_CATEGORY, JUMP_SPEED_BY_CATEGORY, fastestEfforts, fastestEffortsAlong } from '../src/api/fastestEfforts.ts'

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

/** Every distance of a run, each unreached. */
const NONE = { '1k': null, mile: null, '5k': null, '10k': null, half: null, marathon: null }

describe('fastestEfforts', () => {
  it('reads each distance off an even 3 m/s run, interpolating where a window starts between fixes', () => {
    // 200 legs of 30 m: 6 km. A kilometre is 33 1/3 legs, so without interpolation it reads 340 s.
    const efforts = fastestEfforts(run([{ speed: 3, fixes: 200 }]), 'run')
    expect(efforts['1k']).toBeCloseTo(1000 / 3, 1)
    expect(efforts['mile']).toBeCloseTo(536.4, 1)
    expect(efforts['5k']).toBeCloseTo(5000 / 3, 1)
  })

  it('finds the fastest kilometre inside a longer run', () => {
    // 1500 m at 3 m/s, 1000 m at 4 m/s, 1500 m at 3 m/s.
    const efforts = fastestEfforts(run([{ speed: 3, fixes: 50 }, { speed: 4, fixes: 25 }, { speed: 3, fixes: 50 }]), 'run')
    expect(efforts['1k']).toBeCloseTo(250, 6)
  })

  it('says how far along the route the fastest stretch began', () => {
    // The fast kilometre runs from 1500 m to 2500 m; each slower window around it starts elsewhere.
    const along = fastestEffortsAlong(run([{ speed: 3, fixes: 50 }, { speed: 4, fixes: 25 }, { speed: 3, fixes: 50 }]), 'run')
    expect(along['1k']?.seconds).toBeCloseTo(250, 6)
    expect(along['1k']?.fromMeters).toBeCloseTo(1500, 1)
    // An even run's fastest 5 km is its first window: a later one only replaces it when strictly
    // quicker. That window ends on the first fix past 5 km (5010 m), so it starts 10 m in, between
    // two fixes, where the interpolation puts it.
    const even = fastestEffortsAlong(run([{ speed: 3, fixes: 200 }]), 'run')
    expect(even['5k']?.fromMeters).toBeCloseTo(10, 1)
    expect(fastestEffortsAlong(run([{ speed: 3, fixes: 30 }]), 'run')).toEqual(NONE)
  })

  it('counts no distance for a leg faster than anybody runs, so a GPS jump sets no record', () => {
    // 3 km at 3 m/s, a fix one second later 300 m further on, then 3 km more at 3 m/s from there.
    // Counted, the jump makes a kilometre of 700 m run plus one second: about 234 s.
    const before = run([{ speed: 3, fixes: 100 }])
    const last = before.at(-1)!
    const jumped = { atMs: last.atMs + 1000, latitude: last.latitude + 300 / METRES_PER_DEGREE, longitude: 5 }
    const after = run([{ speed: 3, fixes: 100 }]).slice(1).map((p) => ({
      atMs: p.atMs - START + jumped.atMs, latitude: p.latitude - 52 + jumped.latitude, longitude: 5,
    }))
    const efforts = fastestEfforts([...before, jumped, ...after], 'run')
    expect(efforts['1k']).toBeCloseTo(1000 / 3, 1)
  })

  it('reads the jump speed from the category: a ride at 15 m/s is riding, a run at 15 m/s is a jump', () => {
    // 25 km at 15 m/s (54 km/h), a fix every 10 s.
    const fast = run([{ speed: 15, fixes: 167 }])
    expect(fastestEfforts(fast, 'ride')['20k']).toBeCloseTo(20_000 / 15, 1)
    // On foot every leg is past 10 m/s, so none adds distance and no kilometre is ever covered.
    expect(fastestEfforts(fast, 'run')['1k']).toBeNull()
  })

  it("drops a ride's leg past the ride's own jump speed", () => {
    // 21 km at 10 m/s with one 10 s leg at 30 m/s in the middle: past 25 m/s, so its 300 m count
    // for nothing and the 20 km is covered only by the 10 m/s riding either side.
    const jumped = run([{ speed: 10, fixes: 100 }, { speed: 30, fixes: 1 }, { speed: 10, fixes: 110 }])
    expect(fastestEfforts(jumped, 'ride')['20k']).toBeCloseTo(2010, 0)
    expect(JUMP_SPEED_BY_CATEGORY).toEqual({ run: 10, walk: 10, ride: 25 })
  })

  it('reads a 25 km ride over its 20 km, with no 40 km or 100 km', () => {
    const ride = fastestEfforts(run([{ speed: 8, fixes: 313 }]), 'ride')
    expect(Object.keys(ride)).toEqual(['20k', '40k', '100k'])
    expect(ride['20k']).toBeCloseTo(2500, 0)
    expect([ride['40k'], ride['100k']]).toEqual([null, null])
  })

  it('reads nothing at all for a category with no distances', () => {
    const route = run([{ speed: 3, fixes: 200 }])
    expect(fastestEffortsAlong(route, 'walk')).toEqual({})
    expect(fastestEffortsAlong(route, 'swim')).toEqual({})
    expect(fastestEffortsAlong(route, 'strength')).toEqual({})
  })

  it('reads the fixes in time order, whatever order they arrive in', () => {
    expect(fastestEfforts([...run([{ speed: 3, fixes: 200 }])].reverse(), 'run')['1k']).toBeCloseTo(1000 / 3, 1)
  })

  it('answers null for every distance longer than the route', () => {
    expect(fastestEfforts(run([{ speed: 3, fixes: 30 }]), 'run')).toEqual(NONE)
    expect(fastestEfforts(run([{ speed: 3, fixes: 40 }]), 'run')).toMatchObject({ mile: null, '5k': null })
    expect(fastestEfforts([], 'run')).toEqual(NONE)
  })

  it('reads a kilometre off a route barely longer than one', () => {
    expect(fastestEfforts(run([{ speed: 4, fixes: 26 }]), 'run')['1k']).toBeCloseTo(250, 6)
  })

  it('names the distances the spec names, per category, shortest first', () => {
    expect(EFFORT_DISTANCES_BY_CATEGORY).toEqual({
      run: [
        { key: '1k', meters: 1000 }, { key: 'mile', meters: 1609.344 }, { key: '5k', meters: 5000 },
        { key: '10k', meters: 10_000 }, { key: 'half', meters: 21_097.5 }, { key: 'marathon', meters: 42_195 },
      ],
      ride: [{ key: '20k', meters: 20_000 }, { key: '40k', meters: 40_000 }, { key: '100k', meters: 100_000 }],
    })
  })
})
