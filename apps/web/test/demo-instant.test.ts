import { describe, it, expect } from 'vitest'
import { localMidnightMs as demoLocalMidnightMs, DEMO_INSTANT_MS, DEMO_CLOCK_MS, DEMO_CLOCK_CEILING_MS } from '../src/demo/instant.js'
// A deliberate cross-package deep import, not '@haelan/core': `localMidnightMs` is a testing-only
// helper the package's public index does not re-export, and this test's whole point is to reach
// past apps/web/src/demo/instant.ts's own reimplementation and check it against the real thing.
import { localMidnightMs as seedLocalMidnightMs, seedArchive } from '../../../packages/core/src/testing/seed.js'

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
  it('starts half an hour before the close of the last day with data', () => {
    // Not midday, which it was until the dashboard redesign: the seed writes the whole of that
    // day, hourly readings through 23:00, and the capture server answers from this same clock, so
    // a midday clock put "Good afternoon" over "today until 23:00". Pinned as an exact
    // relationship so a future edit that quietly moved it (an hour, a day) cannot still look
    // pinned. Not one millisecond before the close either: the clock advances (demoClock.ts says
    // why) and loops back to here at the ceiling, so this is also how much day it replays.
    expect(DEMO_CLOCK_MS).toBe(DEMO_INSTANT_MS - 30 * 60 * 1000)
    const time = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Amsterdam',
    })
    expect(time.format(DEMO_CLOCK_MS)).toBe('23:30')
  })

  it('reads as later than every intraday reading the seed writes for that day', () => {
    // Against the seed's real output rather than a copy of its hour arithmetic: the last day's
    // heart rate and steps are what the glance reports "as of" and "today until", and a clock
    // earlier than them shows a page whose data comes from its own future.
    const puts: Array<{ dataType: string, body: unknown }> = []
    const archive = { put: (row: { dataType: string, body: unknown }) => { puts.push(row) } }
    type Archive = Parameters<typeof seedArchive>[0]['archive']
    seedArchive({ archive: archive as unknown as Archive, personId: 'p', days: 1, endMs: DEMO_INSTANT_MS })
    const readings = puts
      .filter((row) => row.dataType === 'heart-rate' || row.dataType === 'steps')
      .map((row) => (typeof row.body === 'string' ? row.body : JSON.stringify(row.body)))
      // A heart-rate sample's physicalTime, a step interval's startTime: the instant the point is at.
      .flatMap((text) => [...text.matchAll(/"(?:physicalTime|startTime)":"([^"]+)"/g)].map((m) => Date.parse(m[1]!)))
    expect(readings.length).toBeGreaterThan(0)
    const last = Math.max(...readings)
    // The day really does run late: this is the gap the move closes, not a vacuous bound.
    expect(last).toBeGreaterThanOrEqual(DEMO_INSTANT_MS - 60 * 60 * 1000)
    expect(DEMO_CLOCK_MS).toBeGreaterThan(last)
  })

  it('may not run past the day it starts in', () => {
    // The ceiling is the last millisecond of that same day, so a tab left open past midnight
    // cannot cross into a date with no fixtures.
    expect(DEMO_CLOCK_CEILING_MS).toBe(DEMO_INSTANT_MS - 1)
    expect(DEMO_CLOCK_CEILING_MS).toBeGreaterThan(DEMO_CLOCK_MS)
  })

  it('formats to the day before DEMO_END_DATE in Amsterdam time, not the same day', () => {
    const format = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(ms)
    expect(format(DEMO_CLOCK_MS)).toBe('2026-09-06')
    expect(format(DEMO_INSTANT_MS)).toBe('2026-09-07')
  })
})
