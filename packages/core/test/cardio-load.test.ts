import { describe, expect, it } from 'vitest'
import { edwardsLoad, ageAt, banisterLoad, coefficientFor } from '../src/api/cardioLoad.ts'

describe('Edwards TRIMP', () => {
  it('weights each zone by its rank', () => {
    expect(edwardsLoad({
      lightMinutes: 10, moderateMinutes: 10, vigorousMinutes: 10, peakMinutes: 10,
    })).toBe(100)
  })

  // Absence among present zones is zero minutes spent there, which is a real reading of the day.
  it('counts an absent zone as no time in it, when another zone was recorded', () => {
    expect(edwardsLoad({
      lightMinutes: 30, moderateMinutes: null, vigorousMinutes: null, peakMinutes: null,
    })).toBe(30)
  })

  // Absence of every zone is not a load of zero, it is no load recorded at all. The two are
  // different statements and the daily derive turns the second into no row.
  it('answers null when no zone was recorded at all', () => {
    expect(edwardsLoad({
      lightMinutes: null, moderateMinutes: null, vigorousMinutes: null, peakMinutes: null,
    })).toBeNull()
  })

  it('keeps a recorded zero as a load of zero, not as absence', () => {
    expect(edwardsLoad({
      lightMinutes: 0, moderateMinutes: 0, vigorousMinutes: 0, peakMinutes: 0,
    })).toBe(0)
  })
})

describe('ageAt', () => {
  it('counts a birthday that has passed this year', () => {
    expect(ageAt('1985-03-04', '2026-09-13')).toBe(41)
  })

  it('does not count a birthday still to come this year', () => {
    expect(ageAt('1985-12-04', '2026-09-13')).toBe(40)
  })

  it('counts the birthday itself', () => {
    expect(ageAt('1985-09-13', '2026-09-13')).toBe(41)
  })

  // A 29 February birthday has not come round on 28 February and has on 1 March. Comparing the
  // MM-DD text gets this right without a Date object, which is the reason this function takes two
  // local date strings rather than an instant.
  it('places a leap day birthday between 28 February and 1 March', () => {
    expect(ageAt('2000-02-29', '2027-02-28')).toBe(26)
    expect(ageAt('2000-02-29', '2027-03-01')).toBe(27)
  })

  it('refuses text that is not a local date', () => {
    expect(ageAt('not a date', '2026-09-13')).toBeNull()
    expect(ageAt('1985-03-04', 'nonsense')).toBeNull()
  })
})

const minute = (bpm: number, index: number) => ({ utcMs: index * 60_000, bpm })

describe('Banister TRIMP', () => {
  it('uses 1.92 for male and 1.67 for female', () => {
    expect(coefficientFor('male')).toBe(1.92)
    expect(coefficientFor('female')).toBe(1.67)
  })

  // One minute at exactly half of heart rate reserve: dHR = 0.5, so the minute contributes
  // 1 * 0.5 * e^(1.92 * 0.5) = 0.5 * e^0.96.
  it('sums dt * dHR * e^(k * dHR) over the minutes', () => {
    const load = banisterLoad([minute(120, 0)], { restingBpm: 60, maxBpm: 180, k: 1.92 })
    expect(load).toBeCloseTo(0.5 * Math.exp(0.96), 10)
  })

  it('adds one contribution per minute', () => {
    const one = banisterLoad([minute(120, 0)], { restingBpm: 60, maxBpm: 180, k: 1.92 })!
    const three = banisterLoad(
      [minute(120, 0), minute(120, 1), minute(120, 2)],
      { restingBpm: 60, maxBpm: 180, k: 1.92 },
    )!
    expect(three).toBeCloseTo(one * 3, 10)
  })

  // A minute below resting must not subtract load. Clamped at zero rather than dropped, so the
  // minute still counts as observed.
  it('clamps a reading below resting to no contribution', () => {
    expect(banisterLoad([minute(50, 0)], { restingBpm: 60, maxBpm: 180, k: 1.92 })).toBe(0)
  })

  // A denominator of zero or less is not a number anyone means, and e^(k * huge) would otherwise
  // answer Infinity from a profile that is merely wrong.
  it('refuses a maximum at or below resting', () => {
    expect(banisterLoad([minute(120, 0)], { restingBpm: 180, maxBpm: 180, k: 1.92 })).toBeNull()
    expect(banisterLoad([minute(120, 0)], { restingBpm: 190, maxBpm: 180, k: 1.92 })).toBeNull()
  })

  it('answers null for no minutes at all, not a load of zero', () => {
    expect(banisterLoad([], { restingBpm: 60, maxBpm: 180, k: 1.92 })).toBeNull()
  })
})
