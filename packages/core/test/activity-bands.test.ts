import { describe, it, expect } from 'vitest'
import { deriveActivityBandsDay, mergeActivityBandsDay } from '../src/derive/activityBands.ts'
import type { SampleLike } from '../src/derive/rollup.ts'
import type { Priority } from '../src/derive/priority.ts'

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

  it('does not count a minute where the peak sample is zero', () => {
    // A peak sample valued 0 means zero peak minutes at that instant - it must not put the
    // instant into the peak set at all, even though a level sample at the same minute is real.
    const rows = derive([
      sample('active_minutes_vigorous', 0, 1),
      sample('active_zone_minutes_peak', 0, 0),
    ])
    expect(rows).toEqual([])
  })

  it('does not count a minute where the level sample is zero', () => {
    // A level sample valued 0 means zero minutes at that level - it must not count as an overlap
    // even though the instant is in the peak set.
    const rows = derive([
      sample('active_minutes_vigorous', 0, 0),
      sample('active_zone_minutes_peak', 0, 2),
    ])
    expect(rows).toEqual([])
  })

  it('does not count a minute where both the level and peak samples are zero', () => {
    const rows = derive([
      sample('active_minutes_vigorous', 0, 0),
      sample('active_zone_minutes_peak', 0, 0),
    ])
    expect(rows).toEqual([])
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

function at(sourceId: string, metric: string, minute: number, value: number): SampleLike {
  return { sourceId, metric, utcMs: BASE + minute * MINUTE, tzOffsetMinutes: 120, agg: 'raw', value, n: 1 }
}

// Lower wins. 'watch' beats 'phone' for every metric.
const priority: Priority = { rank: (_metric, sourceId) => (sourceId === 'watch' ? 0 : 1) }

function merged(rows: SampleLike[]) {
  return mergeActivityBandsDay({ personId: 'p1', localDate: '2026-08-17', rows, priority })
}

describe('mergeActivityBandsDay', () => {
  it('counts an overlap the winning source recorded on its own', () => {
    const rows = merged([
      at('watch', 'active_minutes_vigorous', 0, 1),
      at('watch', 'active_zone_minutes_peak', 0, 2),
    ])
    expect(rows.find((r) => r.metric === 'active_minutes_vigorous_peak')?.value).toBe(1)
    expect(rows[0]?.source).toBe('merged')
  })

  it('never intersects across sources within an hour', () => {
    // The winner recorded the level, a loser recorded the peak minute. A cross-device match here
    // would claim the two watches described the same minute of effort. They did not.
    const rows = merged([
      at('watch', 'active_minutes_vigorous', 0, 1),
      at('phone', 'active_zone_minutes_peak', 0, 2),
    ])
    expect(rows).toEqual([])
  })

  it('lets a lower priority source own an hour the winner said nothing about', () => {
    // 12:00 UTC is hour 14 local at +120; 23:00 UTC is hour 1 of the next local day, so use 13:00.
    const rows = merged([
      at('watch', 'active_minutes_vigorous', 0, 1),
      at('watch', 'active_zone_minutes_peak', 0, 2),
      at('phone', 'active_minutes_light', 60, 1),
      at('phone', 'active_zone_minutes_peak', 60, 2),
    ])
    expect(rows.find((r) => r.metric === 'active_minutes_vigorous_peak')?.value).toBe(1)
    expect(rows.find((r) => r.metric === 'active_minutes_light_peak')?.value).toBe(1)
  })

  it('writes no merged rows when nothing overlaps', () => {
    expect(merged([at('watch', 'active_minutes_light', 0, 1)])).toEqual([])
  })
})
