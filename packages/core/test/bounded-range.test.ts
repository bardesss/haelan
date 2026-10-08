import { describe, expect, it } from 'vitest'
import { requireBoundedSpan, spanBeyondLimit } from '../src/derive/boundedRange.ts'
import { MAX_RANGE_DAYS, rangeSpanDays, shiftLocalDate } from '../src/derive/localDay.ts'
import { ConfigError } from '../src/errors.ts'

describe('rangeSpanDays', () => {
  it('counts both ends, and answers NaN for something that is not a date', () => {
    expect(rangeSpanDays('2026-08-01', '2026-08-01')).toBe(1)
    expect(rangeSpanDays('2026-02-01', '2026-03-01')).toBe(29)
    expect(rangeSpanDays('garbage', '2026-03-01')).toBeNaN()
  })
})

describe('spanBeyondLimit and requireBoundedSpan', () => {
  it('lets the widest allowed range through and refuses one day more with the one sentence', () => {
    const from = '2016-01-01'
    expect(spanBeyondLimit(from, shiftLocalDate(from, MAX_RANGE_DAYS - 1))).toBeNull()
    const to = shiftLocalDate(from, MAX_RANGE_DAYS)
    const sentence = `range '${from}'..'${to}' spans ${MAX_RANGE_DAYS + 1} days, more than the ${MAX_RANGE_DAYS} day maximum`
    expect(spanBeyondLimit(from, to)).toBe(sentence)
    expect(() => requireBoundedSpan(from, to)).toThrow(new ConfigError(sentence))
  })

  it('leaves a malformed range to the date checks that name which date is wrong', () => {
    expect(spanBeyondLimit('garbage', '2026-03-01')).toBeNull()
  })
})
