import { describe, expect, it } from 'vitest'
import { trendOf, TREND_MIN_POINTS } from '../src/query/trend.ts'

const point = (localDate: string, value: number | null) => ({ localDate, value })

describe('trendOf', () => {
  it('smooths a noisy series without moving its start or end', () => {
    const noisy = [
      point('2026-08-01', 80), point('2026-08-02', 84), point('2026-08-03', 79),
      point('2026-08-04', 83), point('2026-08-05', 78), point('2026-08-06', 82),
      point('2026-08-07', 80),
    ]
    const out = trendOf(noisy)
    expect(out).toHaveLength(noisy.length)
    expect(out[0]?.value).toBe(80)
    // The smoothed line sits inside the range it smooths: a trend that overshoots the data is
    // drawing something the scale has no reading for.
    for (const p of out) {
      expect(p.value).toBeGreaterThanOrEqual(78)
      expect(p.value).toBeLessThanOrEqual(84)
    }
  })

  // A line through two points is not a trend, it is the two points. Drawing one would claim a
  // direction the data does not support, which is the same failure the thin baseline flag exists
  // to prevent.
  it('returns nothing for a series too short to smooth, rather than a straight line', () => {
    expect(trendOf([point('2026-08-01', 80), point('2026-08-02', 81)])).toEqual([])
    expect(TREND_MIN_POINTS).toBeGreaterThan(2)
  })

  it('ignores a day with no reading rather than treating it as zero', () => {
    const withGap = [
      point('2026-08-01', 80), point('2026-08-02', null), point('2026-08-03', 80),
      point('2026-08-04', 80), point('2026-08-05', 80),
    ]
    const out = trendOf(withGap)
    // A null dragged in as a zero would pull the line to about 64 on day three.
    for (const p of out) expect(p.value).toBeCloseTo(80, 5)
    expect(out.some((p) => p.localDate === '2026-08-02')).toBe(false)
  })
})
