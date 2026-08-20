import { describe, expect, it } from 'vitest'
import { dayWindows } from '../src/sync/windows.ts'

const AMS = 'Europe/Amsterdam'

describe('dayWindows', () => {
  it('produces one window per local day, aligned to local midnight', () => {
    const w = dayWindows({
      fromMs: Date.parse('2026-08-17T12:00:00Z'), toMs: Date.parse('2026-08-19T12:00:00Z'), timezone: AMS,
    })
    expect(w.map((x) => x.localDate)).toEqual(['2026-08-17', '2026-08-18', '2026-08-19'])
  })

  it('starts each window at local midnight, not UTC midnight', () => {
    const [first] = dayWindows({
      fromMs: Date.parse('2026-08-18T12:00:00Z'), toMs: Date.parse('2026-08-18T13:00:00Z'), timezone: AMS,
    })
    expect(new Date(first!.startMs).toISOString()).toBe('2026-08-17T22:00:00.000Z')
  })

  it('gives the same window for any two instants inside one local day, which is what makes dedup work', () => {
    const a = dayWindows({ fromMs: Date.parse('2026-08-18T06:00:00Z'), toMs: Date.parse('2026-08-18T07:00:00Z'), timezone: AMS })
    const b = dayWindows({ fromMs: Date.parse('2026-08-18T20:00:00Z'), toMs: Date.parse('2026-08-18T21:00:00Z'), timezone: AMS })
    expect(a[0]?.startMs).toBe(b[0]?.startMs)
    expect(a[0]?.endMs).toBe(b[0]?.endMs)
  })

  it('makes each window end where the next begins, with no gap and no overlap', () => {
    const w = dayWindows({
      fromMs: Date.parse('2026-08-17T00:00:00Z'), toMs: Date.parse('2026-08-20T00:00:00Z'), timezone: AMS,
    })
    for (let i = 1; i < w.length; i++) expect(w[i]?.startMs).toBe(w[i - 1]?.endMs)
  })

  it('handles the spring transition, where a local day is 23 hours', () => {
    const w = dayWindows({
      fromMs: Date.parse('2026-03-29T00:00:00Z'), toMs: Date.parse('2026-03-29T12:00:00Z'), timezone: AMS,
    })
    const day = w.find((x) => x.localDate === '2026-03-29')
    expect(day && (day.endMs - day.startMs) / 3_600_000).toBe(23)
  })

  it('handles the autumn transition, where a local day is 25 hours', () => {
    const w = dayWindows({
      fromMs: Date.parse('2026-10-25T00:00:00Z'), toMs: Date.parse('2026-10-25T12:00:00Z'), timezone: AMS,
    })
    const day = w.find((x) => x.localDate === '2026-10-25')
    expect(day && (day.endMs - day.startMs) / 3_600_000).toBe(25)
  })

  it('returns nothing for a reversed range rather than looping', () => {
    expect(dayWindows({ fromMs: 2000, toMs: 1000, timezone: AMS })).toEqual([])
  })

  it('refuses an unreasonable span rather than generating a million windows', () => {
    expect(() => dayWindows({ fromMs: 0, toMs: Date.parse('2100-01-01T00:00:00Z'), timezone: AMS }))
      .toThrow(/span/)
  })
})
