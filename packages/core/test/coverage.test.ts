import { describe, expect, it } from 'vitest'
import { coverageOf } from '../src/derive/coverage.ts'

const OFFSET = 120
// Local midnight on 2026-08-22 in a +120 minute zone.
const MIDNIGHT_UTC = Date.UTC(2026, 7, 21, 22, 0)
const atHour = (hour: number, minute = 0) => ({
  utcMs: MIDNIGHT_UTC + hour * 3_600_000 + minute * 60_000,
  tzOffsetMinutes: OFFSET,
})

describe('coverage', () => {
  it('counts hours carrying at least one sample, not samples', () => {
    // Sixty readings in one hour is one hour of observation, not sixty.
    const rows = Array.from({ length: 60 }, (_, minute) => atHour(9, minute))
    expect(coverageOf(rows)).toBeCloseTo(1 / 24)
  })

  it('reads a full day as one', () => {
    expect(coverageOf(Array.from({ length: 24 }, (_, hour) => atHour(hour)))).toBe(1)
  })

  it('degrades the way a reader expects when a watch comes off to charge', () => {
    const worn = Array.from({ length: 24 }, (_, hour) => hour).filter((h) => h !== 3 && h !== 4)
    expect(coverageOf(worn.map((h) => atHour(h)))).toBeCloseTo(22 / 24)
  })

  it('is zero for no rows, which is a day nobody observed', () => {
    expect(coverageOf([])).toBe(0)
  })

  it('means the same thing for a metric reported once a week', () => {
    // One weight reading is one observed hour out of twenty four. The number is honest; what
    // a thin coverage means for an insight is M2d's decision, not this function's.
    expect(coverageOf([atHour(8)])).toBeCloseTo(1 / 24)
  })
})
