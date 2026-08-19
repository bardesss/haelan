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
})

describe('parseCivilDate', () => {
  it('formats a civil date as ISO, zero padded', () => {
    expect(parseCivilDate({ year: 2026, month: 8, day: 3 })).toBe('2026-08-03')
  })

  it('treats an omitted zero-valued component as absent data, not as a date', () => {
    expect(parseCivilDate({ year: 2026 })).toBeNull()
    expect(parseCivilDate({})).toBeNull()
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
})
