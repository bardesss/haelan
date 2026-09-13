import { describe, it, expect } from 'vitest'
import { localMidnightMs as demoLocalMidnightMs, DEMO_INSTANT_MS, DEMO_CLOCK_MS } from '../src/demo/instant.js'
// A deliberate cross-package deep import, not '@haelan/core': `localMidnightMs` is a testing-only
// helper the package's public index does not re-export, and this test's whole point is to reach
// past apps/web/src/demo/instant.ts's own reimplementation and check it against the real thing.
import { localMidnightMs as seedLocalMidnightMs } from '../../../packages/core/src/testing/seed.js'

/**
 * instant.ts's own comment explains why its arithmetic is a deliberate copy of
 * packages/core/src/testing/seed.ts's `localMidnightMs` rather than an import of it (that file
 * pulls in `node:crypto` and a data generator this browser-bound module must never bundle). A
 * comment naming the seed as authority does not, on its own, keep the two in sync - only a test
 * that runs both and compares does. If either implementation's DST rule drifts from the other, the
 * demo's default range would end up one day off its own data (the plan's own stated failure mode),
 * silently, since nothing else would notice.
 *
 * Swept across dates that straddle both DST transitions (not just the demo's own September date),
 * so a future correction to either side's offset boundary - not only a typo in the constant - fails
 * this test instead of drifting unnoticed.
 */
describe('the demo instant agrees with the seed it is copied from', () => {
  const dates = [
    '2025-09-07', // a year before the demo's own date, to prove this is not hardcoded to 2026
    '2026-01-15', // deep winter, CET
    '2026-03-28', // the day before 2026's spring transition (2026-03-29T01:00Z)
    '2026-03-29', // transition day itself - still CET at UTC midnight, before the 01:00Z switch
    '2026-03-30', // the day after - CEST
    '2026-06-15', // deep summer, CEST
    '2026-09-07', // the demo's own DEMO_END_DATE
    '2026-10-24', // the day before 2026's autumn transition (2026-10-25T01:00Z)
    '2026-10-25', // transition day itself - still CEST at UTC midnight, before the 01:00Z switch
    '2026-10-26', // the day after - back to CET
    '2026-12-15', // deep winter again, CET
    '2027-04-01', // a different year, well clear of its own transition
  ]

  it.each(dates)('agrees with the seed for %s', (date) => {
    expect(demoLocalMidnightMs(date)).toBe(seedLocalMidnightMs(date))
  })
})

/**
 * DEMO_CLOCK_MS exists because DEMO_INSTANT_MS cannot be what a clock is pinned to: it is the
 * archive's exclusive close, the first instant with no data, and DEMO_END_DATE (2026-09-07) is a
 * Monday, so a clock reading it as "now" put the demo's own default Day and Week views entirely
 * past the last row the seed ever wrote (this suite's own controller review caught it against the
 * recorded manifest, not against this test - nothing here exercised the pinned-clock path before).
 * Pinned here as an exact relationship, not just "close to DEMO_INSTANT_MS": a future edit that
 * quietly changed the offset (a whole day, an hour) would still "look pinned" without this.
 */
describe('DEMO_CLOCK_MS', () => {
  it('is exactly one millisecond before the archive\'s exclusive close', () => {
    expect(DEMO_CLOCK_MS).toBe(DEMO_INSTANT_MS - 1)
  })

  it('formats to the day before DEMO_END_DATE in Amsterdam time, not the same day', () => {
    const format = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(ms)
    expect(format(DEMO_CLOCK_MS)).toBe('2026-09-06')
    expect(format(DEMO_INSTANT_MS)).toBe('2026-09-07')
  })
})
