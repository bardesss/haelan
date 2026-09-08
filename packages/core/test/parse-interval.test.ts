import { describe, expect, it } from 'vitest'
import { parseIntervalMinutes } from '../src/api/parse.ts'

describe('parseIntervalMinutes', () => {
  it('measures an ordinary interval', () => {
    expect(parseIntervalMinutes({
      startTime: '2026-08-21T09:00:00Z', startUtcOffset: '7200s',
      endTime: '2026-08-21T09:30:00Z', endUtcOffset: '7200s',
    })).toBe(30)
  })

  // The two ends can sit under different offsets across a DST change. The duration is the
  // difference between two absolute instants, so an offset cannot affect it - asserted rather
  // than assumed, because a mapper that subtracted local wall clocks would pass every other test.
  it('is unaffected by the offsets, including when they differ', () => {
    expect(parseIntervalMinutes({
      startTime: '2026-10-25T00:30:00Z', startUtcOffset: '7200s',
      endTime: '2026-10-25T01:30:00Z', endUtcOffset: '3600s',
    })).toBe(60)
  })

  it('answers null when either end is missing', () => {
    expect(parseIntervalMinutes({ startTime: '2026-08-21T09:00:00Z' })).toBeNull()
    expect(parseIntervalMinutes({ endTime: '2026-08-21T09:30:00Z' })).toBeNull()
  })

  it('answers null for something that is not an interval', () => {
    expect(parseIntervalMinutes(null)).toBeNull()
    expect(parseIntervalMinutes('2026-08-21')).toBeNull()
    expect(parseIntervalMinutes({ startTime: 'not a time', endTime: 'also not' })).toBeNull()
  })

  // An end before its start is drift, not a negative duration.
  it('answers null when the interval runs backwards', () => {
    expect(parseIntervalMinutes({
      startTime: '2026-08-21T09:30:00Z', endTime: '2026-08-21T09:00:00Z',
    })).toBeNull()
  })

  it('keeps sub-minute precision rather than rounding to zero', () => {
    expect(parseIntervalMinutes({
      startTime: '2026-08-21T09:00:00Z', endTime: '2026-08-21T09:00:30Z',
    })).toBe(0.5)
  })
})
