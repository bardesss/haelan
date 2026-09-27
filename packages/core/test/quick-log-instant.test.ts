import { describe, expect, it } from 'vitest'
import { quickLogInstant } from '../src/query/quickLog.ts'
import { localDateInZone, localMidnightMs } from '../src/index.ts'

const TZ = 'Europe/Amsterdam'
const at = (date: string, hh: number, mm = 0, tz = TZ) => localMidnightMs(date, tz) + (hh * 60 + mm) * 60_000

describe('quickLogInstant', () => {
  it('logs today at the request instant, with the zone offset then', () => {
    const nowMs = at('2026-09-26', 15, 12)
    expect(quickLogInstant({ day: '2026-09-26', today: '2026-09-26', nowMs, timeZone: TZ, nightStartMs: null }))
      .toEqual({ startedAtMs: nowMs, startedAtOffsetMinutes: 120 })
  })
  it('logs a past day an hour before the bedtime of the night that followed it', () => {
    const bed = at('2026-09-25', 23, 30)
    expect(quickLogInstant({ day: '2026-09-25', today: '2026-09-26', nowMs: at('2026-09-26', 9), timeZone: TZ, nightStartMs: bed }))
      .toEqual({ startedAtMs: bed - 3_600_000, startedAtOffsetMinutes: 120 })
  })
  it('logs a past day at 21:00 local when no night followed it', () => {
    const r = quickLogInstant({ day: '2026-09-20', today: '2026-09-26', nowMs: at('2026-09-26', 9), timeZone: TZ, nightStartMs: null })
    expect(r.startedAtMs).toBe(at('2026-09-20', 21))
  })
  it('keeps a night that began after midnight on the day it follows', () => {
    const bed = at('2026-09-26', 2, 10) // bedtime 02:10 on the 26th: an hour before is still the 26th
    const r = quickLogInstant({ day: '2026-09-25', today: '2026-09-27', nowMs: at('2026-09-27', 9), timeZone: TZ, nightStartMs: bed })
    expect(localDateInZone(r.startedAtMs, TZ)).toBe('2026-09-25')
    expect(r.startedAtMs).toBe(at('2026-09-25', 23, 59))
  })
  it('places 21:00 by the wall clock on the day the clocks go back', () => {
    const r = quickLogInstant({ day: '2026-10-25', today: '2026-10-27', nowMs: at('2026-10-27', 9), timeZone: TZ, nightStartMs: null })
    expect(r).toEqual({ startedAtMs: Date.UTC(2026, 9, 25, 20, 0), startedAtOffsetMinutes: 60 })
  })
  it('handles a zone with a non-hour offset', () => {
    const r = quickLogInstant({ day: '2026-09-20', today: '2026-09-26', nowMs: Date.UTC(2026, 8, 26, 4), timeZone: 'Asia/Kolkata', nightStartMs: null })
    expect(r).toEqual({ startedAtMs: Date.UTC(2026, 8, 20, 15, 30), startedAtOffsetMinutes: 330 })
  })
  it('refuses a day after today', () => {
    expect(() => quickLogInstant({ day: '2026-09-27', today: '2026-09-26', nowMs: 0, timeZone: TZ, nightStartMs: null })).toThrow(/after today/)
  })
})
