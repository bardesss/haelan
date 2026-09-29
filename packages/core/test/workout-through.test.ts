import { describe, expect, it } from 'vitest'
import { cadenceSeries, paceSeries } from '../src/query/workoutThrough.ts'

const START = Date.parse('2026-09-04T05:00:00Z')
// Metres per degree of latitude on the 6,371 km sphere, so a fix moved north by d / this is d metres on.
const METRES_PER_DEGREE = (6_371_000 * Math.PI) / 180

/** A fix every 10 s from START, heading north at each fix's speed in m/s (the speed of the 10 s before it). */
function route(speeds: readonly number[]) {
  let latitude = 52
  return [{ atMs: START, latitude, longitude: 5 }, ...speeds.map((speed, i) => {
    latitude += (speed * 10) / METRES_PER_DEGREE
    return { atMs: START + (i + 1) * 10_000, latitude, longitude: 5 }
  })]
}

describe('paceSeries', () => {
  it('reads 3 m/s as about 5:33 a kilometre, every minute of it', () => {
    const series = paceSeries(route(Array(60).fill(3)), START)!
    expect(series.unit).toBe('seconds_per_km')
    expect(series.points.map((p) => p.elapsedSeconds)).toEqual([0, 60, 120, 180, 240, 300, 360, 420, 480, 540])
    for (const p of series.points) expect(p.value).toBeCloseTo(1000 / 3, 1)
  })

  it('leaves a stopped minute out, and keeps it out of its neighbours\' means', () => {
    // Minutes 0-2 at 3 m/s, minute 3 standing still, minutes 4-5 at 4 m/s.
    const series = paceSeries(route([...Array(18).fill(3), ...Array(6).fill(0), ...Array(12).fill(4)]), START)!
    expect(series.points.map((p) => p.elapsedSeconds)).toEqual([0, 60, 120, 240, 300])
    expect(series.points[2]!.value).toBeCloseTo(1000 / 3, 1)
    expect(series.points[3]!.value).toBeCloseTo(250, 1)
  })

  it('draws a minute of just over 50 m and leaves out one of just under', () => {
    const series = paceSeries(route([...Array(6).fill(51 / 60), ...Array(6).fill(49 / 60)]), START)!
    expect(series.points.map((p) => p.elapsedSeconds)).toEqual([0])
  })

  it('smooths each minute with the minutes either side of it', () => {
    // 3, 4 and 3 m/s: the middle minute's own 250 s/km becomes the mean of 333.3, 250 and 333.3.
    const series = paceSeries(route([...Array(6).fill(3), ...Array(6).fill(4), ...Array(6).fill(3)]), START)!
    expect(series.points[1]!.value).toBeCloseTo((1000 / 3 + 250 + 1000 / 3) / 3, 1)
    expect(series.points[0]!.value).toBeCloseTo((1000 / 3 + 250) / 2, 1)
  })

  it('reads a minute the fixes only partly span over the seconds they do span', () => {
    // Ninety seconds at 3 m/s: the second minute is thirty seconds of the same pace, not a slow minute.
    const series = paceSeries(route(Array(9).fill(3)), START)!
    expect(series.points.map((p) => p.elapsedSeconds)).toEqual([0, 60])
    expect(series.points[1]!.value).toBeCloseTo(1000 / 3, 1)
  })

  it('is null for a single fix, and for a route that never moves', () => {
    expect(paceSeries(route([]), START)).toBeNull()
    expect(paceSeries(route(Array(12).fill(0)), START)).toBeNull()
  })
})

describe('cadenceSeries', () => {
  const rows = (everyMs: number, count: number, value: number) =>
    Array.from({ length: count }, (_, i) => ({ utcMs: START + i * everyMs, value }))

  it('reads rows a minute apart as steps per minute', () => {
    const series = cadenceSeries(rows(60_000, 20, 170), START, START + 20 * 60_000)!
    expect(series.unit).toBe('steps_per_minute')
    expect(series.points).toHaveLength(20)
    for (const p of series.points) expect(p.value).toBe(170)
  })

  it('adds rows closer than a minute apart into their minute', () => {
    const series = cadenceSeries(rows(30_000, 40, 85), START, START + 20 * 60_000)!
    expect(series.points).toHaveLength(20)
    for (const p of series.points) expect(p.value).toBe(170)
  })

  it('smooths each minute with the minutes either side of it', () => {
    const series = cadenceSeries([
      { utcMs: START, value: 160 }, { utcMs: START + 60_000, value: 170 }, { utcMs: START + 120_000, value: 180 },
    ], START, START + 180_000)!
    expect(series.points.map((p) => p.value)).toEqual([165, 170, 175])
  })

  it('is null for rows further apart than a minute, hourly or just over', () => {
    expect(cadenceSeries(rows(3_600_000, 3, 5000), START, START + 3 * 3_600_000)).toBeNull()
    expect(cadenceSeries(rows(61_000, 20, 170), START, START + 30 * 60_000)).toBeNull()
  })

  it('judges the spacing by the median, so one long pause does not hide the rest', () => {
    const paused = [...rows(60_000, 10, 170), { utcMs: START + 30 * 60_000, value: 170 }]
    expect(cadenceSeries(paused, START, START + 40 * 60_000)).not.toBeNull()
  })

  it('reads only the rows inside the workout, and is null with fewer than two', () => {
    const series = cadenceSeries(rows(60_000, 20, 170), START + 5 * 60_000, START + 10 * 60_000)!
    expect(series.points.map((p) => p.elapsedSeconds)).toEqual([0, 60, 120, 180, 240])
    expect(cadenceSeries(rows(60_000, 1, 170), START, START + 60_000)).toBeNull()
  })
})
