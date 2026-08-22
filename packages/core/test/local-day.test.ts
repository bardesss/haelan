import { describe, expect, it } from 'vitest'
import { localDateOf, localHourOf, shiftLocalDate } from '../src/derive/localDay.ts'

const AMSTERDAM_SUMMER = 120
const AMSTERDAM_WINTER = 60

describe('local day attribution', () => {
  it('attributes an instant to the day it fell on locally, not in UTC', () => {
    // 22:30 UTC on the 21st is 00:30 on the 22nd in Amsterdam summer time.
    const utcMs = Date.UTC(2026, 7, 21, 22, 30)
    expect(localDateOf(utcMs, AMSTERDAM_SUMMER)).toBe('2026-08-22')
    expect(localHourOf(utcMs, AMSTERDAM_SUMMER)).toBe(0)
  })

  it('reads the offset the sample carries, not one guessed from the date', () => {
    // The same instant under the winter offset is still the 22nd, at 23:30 on the 21st it is
    // not. Each sample brings its own offset because the row already knows it.
    const utcMs = Date.UTC(2026, 7, 21, 23, 30)
    expect(localDateOf(utcMs, AMSTERDAM_SUMMER)).toBe('2026-08-22')
    expect(localDateOf(utcMs, AMSTERDAM_WINTER)).toBe('2026-08-22')
    expect(localHourOf(utcMs, AMSTERDAM_SUMMER)).toBe(1)
    expect(localHourOf(utcMs, AMSTERDAM_WINTER)).toBe(0)
  })

  it('handles a negative offset without rolling the wrong way', () => {
    const utcMs = Date.UTC(2026, 7, 22, 2, 0)
    expect(localDateOf(utcMs, -300)).toBe('2026-08-21')
    expect(localHourOf(utcMs, -300)).toBe(21)
  })

  it('pads month and day, so string ordering is date ordering', () => {
    expect(localDateOf(Date.UTC(2026, 0, 5, 12, 0), 0)).toBe('2026-01-05')
  })
})

describe('shiftLocalDate', () => {
  it('steps a calendar date forwards and backwards', () => {
    expect(shiftLocalDate('2026-08-22', 1)).toBe('2026-08-23')
    expect(shiftLocalDate('2026-08-22', -1)).toBe('2026-08-21')
    expect(shiftLocalDate('2026-08-22', 0)).toBe('2026-08-22')
  })

  it('crosses a month and a year boundary', () => {
    expect(shiftLocalDate('2026-08-31', 1)).toBe('2026-09-01')
    expect(shiftLocalDate('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftLocalDate('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('ignores daylight saving, because a calendar date has no offset to shift', () => {
    // The Amsterdam DST change is on 2026-10-25. Stepping the date across it must not land on
    // the same day twice, which is what stepping a wall clock through it would do.
    expect(shiftLocalDate('2026-10-24', 1)).toBe('2026-10-25')
    expect(shiftLocalDate('2026-10-25', 1)).toBe('2026-10-26')
  })

  it('handles a leap day', () => {
    expect(shiftLocalDate('2028-02-28', 1)).toBe('2028-02-29')
    expect(shiftLocalDate('2028-02-29', 1)).toBe('2028-03-01')
  })
})
