import { describe, expect, it } from 'vitest'
import { edwardsLoad, ageAt } from '../src/api/cardioLoad.ts'

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
