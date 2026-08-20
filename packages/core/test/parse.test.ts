import { describe, expect, it } from 'vitest'
import { parseInstant, parseCivilDate, parseNumeric, valueAt } from '../src/api/parse.ts'

describe('parseNumeric', () => {
  it('accepts the JSON string form the API actually sends for integers', () => {
    expect(parseNumeric('62')).toBe(62)
  })

  it('accepts a genuine number too', () => {
    expect(parseNumeric(97.5)).toBe(97.5)
  })

  it('returns null for absent rather than zero, because missing is not zero', () => {
    expect(parseNumeric(undefined)).toBeNull()
    expect(parseNumeric(null)).toBeNull()
    expect(parseNumeric('')).toBeNull()
  })

  it('returns null for something that is not a number at all', () => {
    expect(parseNumeric('none')).toBeNull()
    expect(parseNumeric({})).toBeNull()
  })

  it('keeps a genuine zero distinct from absent', () => {
    expect(parseNumeric(0)).toBe(0)
    expect(parseNumeric('0')).toBe(0)
  })

  it('pins the numeric acceptance boundary', () => {
    expect(parseNumeric('1e3')).toBe(1000)
    expect(parseNumeric('Infinity')).toBeNull()
  })
})

describe('parseInstant', () => {
  it('reads an RFC3339 instant and its offset', () => {
    expect(parseInstant({ physicalTime: '2026-08-18T22:30:00Z', utcOffset: '7200s' }))
      .toEqual({ utcMs: Date.UTC(2026, 7, 18, 22, 30), tzOffsetMinutes: 120 })
  })

  it('accepts the colon form of an offset as well', () => {
    expect(parseInstant({ physicalTime: '2026-08-18T22:30:00Z', utcOffset: '+02:00' })?.tzOffsetMinutes)
      .toBe(120)
  })

  it('handles a negative offset', () => {
    expect(parseInstant({ physicalTime: '2026-08-18T22:30:00Z', utcOffset: '-18000s' })?.tzOffsetMinutes)
      .toBe(-300)
  })

  it('defaults a missing offset to zero rather than failing, because proto3 omits zero', () => {
    expect(parseInstant({ physicalTime: '2026-08-18T22:30:00Z' })?.tzOffsetMinutes).toBe(0)
  })

  it('returns null when there is no instant at all', () => {
    expect(parseInstant({})).toBeNull()
    expect(parseInstant(undefined)).toBeNull()
  })

  it('falls back to startTime paired with startUtcOffset when physicalTime is absent', () => {
    expect(parseInstant({ startTime: '2026-08-18T22:30:00Z', startUtcOffset: '7200s' }))
      .toEqual({ utcMs: Date.UTC(2026, 7, 18, 22, 30), tzOffsetMinutes: 120 })
  })

  it('falls back to endTime paired with endUtcOffset, not startUtcOffset', () => {
    expect(parseInstant({ endTime: '2026-08-18T22:30:00Z', endUtcOffset: '-18000s' })?.tzOffsetMinutes)
      .toBe(-300)
  })

  it('never pairs one field end timestamp with the other end offset', () => {
    expect(parseInstant({ endTime: '2026-08-18T22:30:00Z', startUtcOffset: '7200s' })?.tzOffsetMinutes)
      .toBe(0)
  })
})

describe('parseCivilDate', () => {
  it('formats a civil date as ISO, zero padded', () => {
    expect(parseCivilDate({ year: 2026, month: 8, day: 3 })).toBe('2026-08-03')
  })

  it('treats an omitted zero-valued component as absent data, not as a date', () => {
    expect(parseCivilDate({ year: 2026 })).toBeNull()
    expect(parseCivilDate({})).toBeNull()
  })

  it('rejects a zero month rather than treating it as a real component', () => {
    expect(parseCivilDate({ year: 2026, month: 0, day: 15 })).toBeNull()
  })

  it('rejects a month out of range', () => {
    expect(parseCivilDate({ year: 2026, month: 13, day: 1 })).toBeNull()
  })

  it('rejects a day out of range', () => {
    expect(parseCivilDate({ year: 2026, month: 8, day: 45 })).toBeNull()
  })
})

describe('valueAt', () => {
  it('walks a dotted path', () => {
    expect(valueAt({ a: { b: { c: 3 } } }, 'a.b.c')).toBe(3)
  })

  it('returns undefined rather than throwing on a missing branch', () => {
    expect(valueAt({ a: {} }, 'a.b.c')).toBeUndefined()
    expect(valueAt(null, 'a')).toBeUndefined()
  })

  it('does not resolve an inherited member as though it were an own key', () => {
    expect(valueAt({}, 'toString')).toBeUndefined()
    expect(valueAt({}, 'constructor')).toBeUndefined()
    expect(valueAt({}, '__proto__.constructor')).toBeUndefined()
  })
})
