import { afterEach, describe, expect, it, vi } from 'vitest'
import { localDateOf, localMidnightMs } from '../src/sync/localDate.ts'
import { dayWindows } from '../src/sync/windows.ts'

const AMS = 'Europe/Amsterdam'
const KTM = 'Asia/Kathmandu'
const NYC = 'America/New_York'

afterEach(() => { vi.restoreAllMocks() })

// Counts constructions without replacing the class: every call still builds a real formatter and
// answers correctly, so a test that spies can also assert the answer. Replacing Intl with a stub
// would prove the cache is consulted and nothing about it being right.
//
// A `function` and not an arrow, which is not a style choice: vitest invokes a mock's
// implementation as the constructor, and `new` on an arrow throws "is not a constructor". The
// arrow version of this helper failed with exactly that, and its symptom was a count of zero -
// which reads like a working cache rather than a broken spy.
function countingIntl(): () => number {
  const real = Intl.DateTimeFormat
  let built = 0
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
    function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      built += 1
      return new real(...args)
    } as unknown as typeof Intl.DateTimeFormat,
  )
  return () => built
}

describe('localDateOf', () => {
  it('gives the civil date in the zone asked for, not the UTC one', () => {
    // 22:00 UTC is already tomorrow in Amsterdam and still today in New York. A formatter that
    // ignored its zone would answer the same string for both.
    const ms = Date.parse('2026-08-17T22:30:00Z')
    expect(localDateOf(ms, AMS)).toBe('2026-08-18')
    expect(localDateOf(ms, NYC)).toBe('2026-08-17')
  })

  it('handles a zone whose offset is not a whole hour', () => {
    expect(localDateOf(Date.parse('2026-08-17T18:20:00Z'), KTM)).toBe('2026-08-18')
  })

  // Every test that counts constructions uses a zone no other test in this file mentions.
  //
  // The cache is process-wide and is never cleared - that is the design, not an oversight, since
  // a formatter for a zone stays correct forever. So a counting test written against a zone a
  // neighbour already touched measures zero constructions and passes whether the cache works or
  // not, which is how the first draft of this file passed for the wrong reason. Fresh zones make
  // each of these independent of what ran before it, including in a different order.
  describe('the cached formatter', () => {
    it('builds one formatter per zone however many times it is called', () => {
      const built = countingIntl()
      for (let i = 0; i < 50; i += 1) {
        localDateOf(Date.parse('2026-08-17T12:00:00Z') + i * 3_600_000, 'Australia/Sydney')
      }
      expect(built()).toBe(1)
    })

    // The failure a cache introduces that the code it replaces could not have: a key that does
    // not include the zone hands the second zone the first zone's formatter, and every date it
    // answers is then confidently wrong rather than absent. Asserted on the answers, not on the
    // construction count, because a wrongly keyed cache builds few formatters too - it just
    // builds them for the wrong zone.
    it('does not hand one zone the formatter built for another', () => {
      const ms = Date.parse('2026-08-17T22:30:00Z')
      expect(localDateOf(ms, AMS)).toBe('2026-08-18')
      expect(localDateOf(ms, NYC)).toBe('2026-08-17')
      expect(localDateOf(ms, KTM)).toBe('2026-08-18')
      // And again in the other order, so an entry written first cannot be what makes it pass.
      expect(localDateOf(ms, KTM)).toBe('2026-08-18')
      expect(localDateOf(ms, NYC)).toBe('2026-08-17')
      expect(localDateOf(ms, AMS)).toBe('2026-08-18')
    })

    it('keeps one formatter per zone across zones, not one for the last zone asked', () => {
      const built = countingIntl()
      for (let i = 0; i < 20; i += 1) {
        localDateOf(Date.parse('2026-08-17T12:00:00Z'), 'Asia/Tokyo')
        localDateOf(Date.parse('2026-08-17T12:00:00Z'), 'America/Sao_Paulo')
      }
      // Two zones, two formatters. A cache holding only the most recent zone would rebuild on
      // every alternation and reach forty.
      expect(built()).toBe(2)
    })
  })

  // The reason this module exists. startOfLocalDay walks back an hour at a time and then bisects
  // to the minute, so one window costs about thirty of these calls, and a sync fetches thousands
  // of windows; a profile put formatter construction at 59% of a sync run. Pinned as a count
  // rather than a duration because this suite runs on hardware it does not choose, and a stopwatch
  // budget on this repo's sync tests has already had to be raised once and narrowed twice.
  it('builds one formatter for a whole span of windows, not one per probe', () => {
    const built = countingIntl()
    const windows = dayWindows({
      fromMs: Date.parse('2026-08-01T00:00:00Z'), toMs: Date.parse('2026-08-31T00:00:00Z'),
      timezone: 'Africa/Cairo',
    })
    expect(windows.length).toBeGreaterThan(28)
    expect(built()).toBe(1)
  })
})

describe('localMidnightMs', () => {
  it('finds the instant local midnight opens a date in a zone ahead of UTC', () => {
    expect(localMidnightMs('2026-09-22', AMS)).toBe(Date.parse('2026-09-21T22:00:00Z'))
  })

  // 2026-10-25 is still summer time (CEST, UTC+2); the clocks go back on 2026-10-25 03:00 CEST,
  // so 2026-10-26 opens under winter time (CET, UTC+1). Reading the offset twice, the second time
  // at the first answer, is what makes the day the change itself falls on come out right.
  it('answers the day the clocks go back with the offset that day started under', () => {
    expect(localMidnightMs('2026-10-25', AMS)).toBe(Date.parse('2026-10-24T22:00:00Z'))
  })

  it('answers the day after the clocks go back with the new offset', () => {
    expect(localMidnightMs('2026-10-26', AMS)).toBe(Date.parse('2026-10-25T23:00:00Z'))
  })

  it('is the plain UTC midnight in UTC itself', () => {
    expect(localMidnightMs('2026-09-22', 'UTC')).toBe(Date.parse('2026-09-22T00:00:00Z'))
  })
})
