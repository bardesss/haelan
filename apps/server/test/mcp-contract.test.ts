import { describe, expect, it } from 'vitest'
import { summaryOf, untrusted, budgetFor, MAX_POINTS, DEFAULT_DAILY_POINTS } from '../src/mcp/contract.ts'

describe('summaryOf', () => {
  it('describes a series with the statistics an agent needs to judge it', () => {
    expect(summaryOf([3, 1, 2, 4])).toEqual({ n: 4, min: 1, max: 4, mean: 2.5, median: 2.5, first: 3, last: 4 })
  })

  it('answers n zero and nulls for an empty series rather than throwing', () => {
    expect(summaryOf([])).toEqual({ n: 0, min: null, max: null, mean: null, median: null, first: null, last: null })
  })

  it('takes the middle value for an odd count', () => {
    expect(summaryOf([5, 1, 3]).median).toBe(3)
  })
})

describe('untrusted', () => {
  it('wraps free text in a field that names what it is', () => {
    expect(untrusted('a note', 100)).toEqual({ untrustedText: 'a note', truncated: false })
  })

  it('truncates at the stated length and says so', () => {
    const out = untrusted('x'.repeat(50), 10)
    expect(out.untrustedText).toHaveLength(10)
    expect(out.truncated).toBe(true)
  })

  it('answers null text rather than an empty string for absent text', () => {
    expect(untrusted(null, 10)).toEqual({ untrustedText: null, truncated: false })
  })
})

describe('budgetFor', () => {
  it('caps a request above the ceiling at the ceiling', () => {
    expect(budgetFor(50_000, DEFAULT_DAILY_POINTS)).toBe(MAX_POINTS)
  })

  it('honours a request below the ceiling', () => {
    expect(budgetFor(50, DEFAULT_DAILY_POINTS)).toBe(50)
  })

  it('falls back to the default when nothing was asked for', () => {
    expect(budgetFor(undefined, DEFAULT_DAILY_POINTS)).toBe(DEFAULT_DAILY_POINTS)
  })

  it('refuses to answer zero or a negative, which would be a series of nothing', () => {
    expect(budgetFor(0, DEFAULT_DAILY_POINTS)).toBe(1)
    expect(budgetFor(-10, DEFAULT_DAILY_POINTS)).toBe(1)
  })
})
