import { describe, expect, it } from 'vitest'
import { cadenceSeries, paceSeries } from '../src/query/workoutThrough.ts'

const START = Date.parse('2026-09-04T05:00:00Z')
/** An end well past every route below, for the tests the end plays no part in. */
const HOUR_ON = START + 3_600_000
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
    const series = paceSeries(route(Array(60).fill(3)), START, HOUR_ON)!
    expect(series.unit).toBe('seconds_per_km')
    expect(series.points.map((p) => p.elapsedSeconds)).toEqual([0, 60, 120, 180, 240, 300, 360, 420, 480, 540])
    for (const p of series.points) expect(p.value).toBeCloseTo(1000 / 3, 1)
  })

  it('leaves a stopped minute out, and keeps it out of its neighbours\' means', () => {
    // Minutes 0-2 at 3 m/s, minute 3 standing still, minutes 4-5 at 4 m/s.
    const series = paceSeries(route([...Array(18).fill(3), ...Array(6).fill(0), ...Array(12).fill(4)]), START, HOUR_ON)!
    expect(series.points.map((p) => p.elapsedSeconds)).toEqual([0, 60, 120, 240, 300])
    expect(series.points[2]!.value).toBeCloseTo(1000 / 3, 1)
    expect(series.points[3]!.value).toBeCloseTo(250, 1)
  })

  it('names the fastest minute by its smoothed pace, and the earlier of a tie', () => {
    // 3, 4, 4, 4, 3 m/s: the middle minute alone smooths to 250 s/km.
    const middle = paceSeries(route([...Array(6).fill(3), ...Array(18).fill(4), ...Array(6).fill(3)]), START, HOUR_ON)!
    expect(middle.fastest!.elapsedSeconds).toBe(120)
    expect(middle.fastest!.secondsPerKm).toBeCloseTo(250, 1)
    expect(middle.fastest!.secondsPerKm).toBe(Math.min(...middle.points.map((p) => p.value)))
    // 4, 4, 3, 3, 4, 4 m/s: the first two and the last two minutes both smooth to 250.
    const tie = paceSeries(route([...Array(12).fill(4), ...Array(12).fill(3), ...Array(12).fill(4)]), START, HOUR_ON)!
    expect(tie.points.at(-1)!.value).toBeCloseTo(250, 1)
    expect(tie.fastest!.elapsedSeconds).toBe(0)
  })

  it('draws a minute of just over 50 m and leaves out one of just under', () => {
    const series = paceSeries(route([...Array(6).fill(51 / 60), ...Array(6).fill(49 / 60)]), START, HOUR_ON)!
    expect(series.points.map((p) => p.elapsedSeconds)).toEqual([0])
  })

  it('smooths each minute with the minutes either side of it', () => {
    // 3, 4 and 3 m/s: the middle minute's own 250 s/km becomes the mean of 333.3, 250 and 333.3.
    const series = paceSeries(route([...Array(6).fill(3), ...Array(6).fill(4), ...Array(6).fill(3)]), START, HOUR_ON)!
    expect(series.points[1]!.value).toBeCloseTo((1000 / 3 + 250 + 1000 / 3) / 3, 1)
    expect(series.points[0]!.value).toBeCloseTo((1000 / 3 + 250) / 2, 1)
  })

  it('reads a minute the fixes only partly span over the seconds they do span', () => {
    // Seventy seconds at 3 m/s: the second minute is ten seconds and 30 m of the same pace, neither
    // a slow minute nor a stop.
    const series = paceSeries(route(Array(7).fill(3)), START, HOUR_ON)!
    expect(series.points.map((p) => p.elapsedSeconds)).toEqual([0, 60])
    expect(series.points[1]!.value).toBeCloseTo(1000 / 3, 1)
  })

  it('leaves a pause out of the minutes it touches, and a minute all pause out altogether', () => {
    // A minute at 3 m/s, a pause the phone logged as one stretch from 60 s to 150 s, then 90 s more
    // at 3 m/s. The third minute is 30 s paused and 30 s running: it reads the running, not 90 m
    // over a whole minute (666 s/km), and the second minute, all pause, is a gap.
    const running = route(Array(6).fill(3))
    const stopped = running.at(-1)!
    const resumed = route(Array(9).fill(3)).map((fix) => ({
      atMs: fix.atMs + 150_000, latitude: stopped.latitude + (fix.latitude - 52), longitude: 5,
    }))
    const series = paceSeries([...running, ...resumed], START, HOUR_ON)!
    expect(series.points.map((p) => p.elapsedSeconds)).toEqual([0, 120, 180])
    for (const p of series.points) expect(p.value).toBeCloseTo(1000 / 3, 1)
  })

  it('leaves out every fix after the end, and the part of a stretch past it', () => {
    // Seventy seconds at 3 m/s, ended at 65 s: the second minute is five seconds of the stretch
    // across the end, the fix at 70 s counts for nothing.
    const series = paceSeries(route(Array(7).fill(3)), START, START + 65_000)!
    expect(series.points.map((p) => p.elapsedSeconds)).toEqual([0, 60])
    expect(series.points[1]!.value).toBeCloseTo(1000 / 3, 1)
    expect(paceSeries(route(Array(7).fill(3)), START, START + 60_000)!.points.map((p) => p.elapsedSeconds)).toEqual([0])
  })

  it('is null for a single fix, and for a route that never moves', () => {
    expect(paceSeries(route([]), START, HOUR_ON)).toBeNull()
    expect(paceSeries(route(Array(12).fill(0)), START, HOUR_ON)).toBeNull()
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

  it('buckets by the wall-clock minute when the workout starts part way through one', () => {
    // Started at 05:00:30, as the window read returns them: a minute of two rows keyed on its
    // start (05:00:00, before the start), a minute of one row keyed on its own instant (05:01:45),
    // then two-row minutes on their starts. Each is its own minute, none dropped, none doubled.
    const start = START + 30_000
    const series = cadenceSeries([
      { utcMs: START, value: 170 }, { utcMs: START + 105_000, value: 170 }, { utcMs: START + 120_000, value: 170 },
      { utcMs: START + 180_000, value: 170 }, { utcMs: START + 240_000, value: 170 }, { utcMs: START + 300_000, value: 170 },
    ], start, start + 300_000)!
    expect(series.points.map((p) => p.elapsedSeconds)).toEqual([0, 60, 120, 180, 240, 300])
    for (const p of series.points) expect(p.value).toBe(170)
  })
})
