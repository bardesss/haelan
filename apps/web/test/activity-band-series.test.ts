import { describe, it, expect } from 'vitest'
import { bandSeries } from '../src/pages/activity/bandSeries.js'

// metric -> dense per-day values, the shape Activity.tsx's `sparklines` memo produces.
const dense = (entries: Record<string, (number | null)[]>) =>
  new Map(Object.entries(entries).map(([metric, values]) => [metric, { values, labels: [] }]))

describe('bandSeries', () => {
  it('subtracts the overlap from its own level and sums it for peak', () => {
    // One day: 10 light, 5 moderate, 8 vigorous, of which 3 vigorous minutes were also peak.
    const series = bandSeries(dense({
      active_minutes_light: [10],
      active_minutes_moderate: [5],
      active_minutes_vigorous: [8],
      active_minutes_light_peak: [0],
      active_minutes_moderate_peak: [0],
      active_minutes_vigorous_peak: [3],
    }))
    expect(series.map((s) => [s.key, s.values[0]])).toEqual([
      ['light', 10], ['moderate', 5], ['vigorous', 5], ['peak', 3],
    ])
    // The point of the whole feature: the bands sum to the distinct active minutes (10+5+8=23),
    // not to 10+5+8+3=26, which is what the originally proposed stack would have printed.
    const total = series.reduce((sum, s) => sum + (s.values[0] ?? 0), 0)
    expect(total).toBe(23)
  })

  it('subtracts a peak minute from the level that actually carried it', () => {
    const series = bandSeries(dense({
      active_minutes_light: [10],
      active_minutes_moderate: [0],
      active_minutes_vigorous: [0],
      active_minutes_light_peak: [4],
      active_minutes_moderate_peak: [0],
      active_minutes_vigorous_peak: [0],
    }))
    expect(series.map((s) => [s.key, s.values[0]])).toEqual([
      ['light', 6], ['moderate', 0], ['vigorous', 0], ['peak', 4],
    ])
  })

  it('never returns a negative band', () => {
    // This does happen on the merged view: mergeDay resolves the winning source per metric per
    // hour, but mergeActivityBandsDay deliberately resolves one winner per hour for the whole
    // band family (activityBands.ts's own comment explains why - intersecting levels and peaks
    // from different sources would invent a minute no device recorded). A person who configures a
    // per-metric priority list that ranks sources differently for a level than for
    // active_zone_minutes_peak can therefore get a merged level and a merged overlap chosen from
    // different hours' winners, and the overlap can come out larger than the level it is supposed
    // to be a subset of. The clamp below is the deliberate response to that, not a dead branch.
    const series = bandSeries(dense({
      active_minutes_light: [1],
      active_minutes_moderate: [0],
      active_minutes_vigorous: [0],
      active_minutes_light_peak: [4],
      active_minutes_moderate_peak: [0],
      active_minutes_vigorous_peak: [0],
    }))
    expect(series.find((s) => s.key === 'light')!.values[0]).toBe(0)
  })

  it('keeps a day nothing reported as a gap in every band', () => {
    const series = bandSeries(dense({
      active_minutes_light: [null],
      active_minutes_moderate: [null],
      active_minutes_vigorous: [null],
      active_minutes_light_peak: [null],
      active_minutes_moderate_peak: [null],
      active_minutes_vigorous_peak: [null],
    }))
    expect(series.map((s) => s.values[0])).toEqual([null, null, null, null])
  })

  it('treats a missing overlap row as no overlap, not a missing day', () => {
    // deriveActivityBandsDay writes no row for a level with no overlap, so the overlap series is
    // null on most days while the level itself is a real number.
    const series = bandSeries(dense({
      active_minutes_light: [10],
      active_minutes_moderate: [0],
      active_minutes_vigorous: [0],
      active_minutes_light_peak: [null],
      active_minutes_moderate_peak: [null],
      active_minutes_vigorous_peak: [null],
    }))
    expect(series.map((s) => [s.key, s.values[0]])).toEqual([
      ['light', 10], ['moderate', 0], ['vigorous', 0], ['peak', 0],
    ])
  })
})
