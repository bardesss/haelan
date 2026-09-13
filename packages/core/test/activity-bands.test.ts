import { describe, it, expect } from 'vitest'
import { deriveActivityBandsDay } from '../src/derive/activityBands.ts'
import type { SampleLike } from '../src/derive/rollup.ts'

const MINUTE = 60_000
const BASE = Date.UTC(2026, 7, 17, 12, 0)

function sample(metric: string, minute: number, value: number): SampleLike {
  return { sourceId: 'watch', metric, utcMs: BASE + minute * MINUTE, tzOffsetMinutes: 120, agg: 'raw', value, n: 1 }
}

function derive(rows: SampleLike[]) {
  return deriveActivityBandsDay({ personId: 'p1', localDate: '2026-08-17', source: 'watch', rows })
}

const valueOf = (rows: ReturnType<typeof derive>, metric: string) =>
  rows.find((r) => r.metric === metric)?.value ?? null

describe('deriveActivityBandsDay', () => {
  it('counts a minute that is both vigorous and peak', () => {
    const rows = derive([
      sample('active_minutes_vigorous', 0, 1),
      sample('active_zone_minutes_peak', 0, 2),
    ])
    expect(valueOf(rows, 'active_minutes_vigorous_peak')).toBe(1)
  })

  it('counts the peak minute once however large its value', () => {
    // A peak sample is worth 2, not 1: it is Fitbit's Active Zone Minutes score, not a duration.
    const rows = derive([
      sample('active_minutes_vigorous', 0, 1),
      sample('active_zone_minutes_peak', 0, 2),
      sample('active_minutes_vigorous', 1, 1),
      sample('active_zone_minutes_peak', 1, 2),
    ])
    expect(valueOf(rows, 'active_minutes_vigorous_peak')).toBe(2)
  })

  it('attributes a peak minute to the level it actually carried', () => {
    const rows = derive([
      sample('active_minutes_light', 0, 1),
      sample('active_zone_minutes_peak', 0, 2),
    ])
    expect(valueOf(rows, 'active_minutes_light_peak')).toBe(1)
    expect(valueOf(rows, 'active_minutes_vigorous_peak')).toBe(null)
  })

  it('writes no row for a level with no overlap rather than a zero', () => {
    const rows = derive([
      sample('active_minutes_light', 0, 1),
      sample('active_minutes_vigorous', 1, 1),
      sample('active_zone_minutes_peak', 1, 2),
    ])
    expect(rows.map((r) => r.metric)).toEqual(['active_minutes_vigorous_peak'])
  })

  it('ignores a non-peak zone minute', () => {
    const rows = derive([
      sample('active_minutes_vigorous', 0, 1),
      sample('active_zone_minutes_cardio', 0, 2),
    ])
    expect(rows).toEqual([])
  })

  it('counts a clock minute once even if the level repeats it under two aggs', () => {
    const rows = derive([
      sample('active_minutes_vigorous', 0, 1),
      { ...sample('active_minutes_vigorous', 0, 1), agg: 'sum' },
      sample('active_zone_minutes_peak', 0, 2),
    ])
    expect(valueOf(rows, 'active_minutes_vigorous_peak')).toBe(1)
  })

  it('stamps the rows as sums on the given source with no coverage or mix', () => {
    const [row] = derive([
      sample('active_minutes_vigorous', 0, 1),
      sample('active_zone_minutes_peak', 0, 2),
    ])
    expect(row).toMatchObject({
      personId: 'p1', localDate: '2026-08-17', source: 'watch', agg: 'sum', coverage: null, sourceMix: null,
    })
  })
})
