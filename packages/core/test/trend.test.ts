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

  // The noisy-series test above and PersonQuery.trend's own tests all use series that pass at
  // ALPHA = 1 (output equals input, no smoothing at all) and at ALPHA = 0 (a flat line at the
  // first reading, no reaction to the data at all): a flat series is unchanged by any amount of
  // smoothing, and a bounded-range check on real data cannot tell a smoothed line from an
  // unsmoothed one. A step change is the one series shape that gives smoothing something to do:
  // the day right after the jump has to sit strictly between the old level and the new one,
  // which only a line that lags the data can produce.
  it('lags a step change, landing strictly between the old level and the new one', () => {
    const step = [
      point('2026-08-01', 80), point('2026-08-02', 80), point('2026-08-03', 80),
      point('2026-08-04', 90), point('2026-08-05', 90), point('2026-08-06', 90),
    ]
    const out = trendOf(step)
    const dayAfterJump = out.find((p) => p.localDate === '2026-08-04')
    expect(dayAfterJump?.value).toBeGreaterThan(80)
    expect(dayAfterJump?.value).toBeLessThan(90)
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
