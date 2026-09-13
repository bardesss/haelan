import { describe, it, expect } from 'vitest'
import { localMidnightMs as demoLocalMidnightMs } from '../src/demo/instant.js'
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
