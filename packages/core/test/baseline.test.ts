import { describe, expect, it } from 'vitest'
import { baselineOf, zScoreOf, BASELINE_WINDOW_DAYS, BASELINE_MIN_DAYS } from '../src/query/baseline.ts'

describe('baselineOf', () => {
  it('returns the mean and the sample standard deviation', () => {
    // Mean 4, deviations -2 -1 0 1 2, squares 4 1 0 1 4 summing to 10, over n-1 = 4, root 1.58114.
    const baseline = baselineOf([2, 3, 4, 5, 6], 1)
    expect(baseline?.center).toBeCloseTo(4, 10)
    expect(baseline?.spread).toBeCloseTo(Math.sqrt(2.5), 10)
    expect(baseline?.n).toBe(5)
  })

  it('returns null for an empty window rather than a zero baseline', () => {
    // A person with no history has no baseline. Zero would be a claim about them.
    expect(baselineOf([], 1)).toBeNull()
  })

  it('reports a single day with no spread rather than dividing by zero', () => {
    // The sample standard deviation's n-1 denominator is zero here. Spread is genuinely unknown
    // from one reading, and zero is the honest floor: it says nothing varies because nothing
    // could have.
    const baseline = baselineOf([70], 1)
    expect(baseline?.center).toBe(70)
    expect(baseline?.spread).toBe(0)
    expect(baseline?.n).toBe(1)
  })

  it('marks a baseline thin when it has fewer days than the minimum', () => {
    expect(baselineOf([1, 2, 3], 14)?.thin).toBe(true)
  })

  it('does not mark a baseline thin at exactly the minimum', () => {
    const values = Array.from({ length: 14 }, (_, at) => at)
    expect(baselineOf(values, 14)?.thin).toBe(false)
  })

  it('defaults its minimum to the stated constant', () => {
    // The threshold lives in one place so a dashboard and an agent cannot disagree about what
    // thin means, which is the whole reason the flag exists rather than a raw count.
    expect(BASELINE_MIN_DAYS).toBe(14)
    expect(BASELINE_WINDOW_DAYS).toBe(60)
    expect(baselineOf(Array.from({ length: 13 }, () => 1))?.thin).toBe(true)
    expect(baselineOf(Array.from({ length: 14 }, () => 1))?.thin).toBe(false)
  })

  it('does not depend on the order the values arrived in', () => {
    const ordered = baselineOf([1, 2, 3, 4, 5], 1)
    const shuffled = baselineOf([5, 1, 4, 2, 3], 1)
    expect(shuffled?.center).toBeCloseTo(ordered!.center, 10)
    expect(shuffled?.spread).toBeCloseTo(ordered!.spread, 10)
  })
})

describe('zScoreOf', () => {
  it('expresses a reading as distance from the centre in units of spread', () => {
    // The sentence the master design wants to be able to say: not "96 bpm" but "1.4 standard
    // deviations above your baseline".
    const baseline = baselineOf([2, 3, 4, 5, 6], 1)!
    expect(zScoreOf(4 + Math.sqrt(2.5), baseline)).toBeCloseTo(1, 10)
    expect(zScoreOf(4 - Math.sqrt(2.5), baseline)).toBeCloseTo(-1, 10)
    expect(zScoreOf(4, baseline)).toBeCloseTo(0, 10)
  })

  it('returns null when the spread is zero, because distance in units of nothing is not a number', () => {
    const flat = baselineOf([70, 70, 70], 1)!
    expect(flat.spread).toBe(0)
    expect(zScoreOf(75, flat)).toBeNull()
  })
})
