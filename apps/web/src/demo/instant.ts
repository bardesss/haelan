/**
 * The instant the seeded archive's server clock is pinned to (`demo/capture/server.ts`'s own
 * `now`): the archive's exclusive close, the first instant with no data behind it. Nothing that
 * needs a *calendar day* should read this one directly - see DEMO_CLOCK_MS below, which is what
 * both the recorder's DOM clock and, later, the browser's own clock (Task 5's demo entry) are
 * pinned to, and why the two are not the same instant.
 *
 * `scripts/seed-demo.mjs` is the authority for this arithmetic: it anchors the seeded archive's
 * exclusive end at `localMidnightMs(DEMO_END_DATE)` (see its own comment, and
 * `packages/core/src/testing/seed.ts`, for why a *local* Amsterdam midnight is used instead of a
 * UTC one). That function lives in the core package's testing folder, which imports `node:crypto`
 * and a data generator this browser-bound module must never pull into the demo bundle, so the
 * handful of lines it needs are reproduced here rather than imported. Keep the two in sync: if
 * either changes, the other has to change with it, or the demo's default range ends up one day off
 * its own data.
 *
 * `localMidnightMs` below is exported (the constant alone would not do) so
 * `apps/web/test/demo-instant.test.ts` can call it directly against a sweep of dates and assert it
 * agrees with the seed's own `localMidnightMs`, including on the DST boundary dates a single
 * shared constant could never exercise. That test is what keeps this deliberate duplication safe -
 * a comment naming the seed as authority does not, on its own, catch a future edit to either side.
 */

// The seed's own fixed end date (scripts/seed-demo.mjs), copied rather than imported for the same
// reason as the arithmetic below - not a value that changes on its own, but a value that has to
// move in both places at once if it ever does.
const DEMO_END_DATE = '2026-09-07'

// Europe/Amsterdam observes CEST (UTC+2) from the last Sunday of March to the last Sunday of
// October, and CET (UTC+1) otherwise - the EU-wide rule, so this is arithmetic rather than a
// timezone database. Copied from packages/core/src/testing/seed.ts's lastSundayUtcMs/amsterdamOffset.
function lastSundayUtcMs(year: number, monthIndex0: number): number {
  const lastOfMonth = new Date(Date.UTC(year, monthIndex0 + 1, 0))
  const sunday = lastOfMonth.getUTCDate() - lastOfMonth.getUTCDay()
  return Date.UTC(year, monthIndex0, sunday, 1, 0, 0)
}

function amsterdamOffsetSeconds(ms: number): number {
  const year = new Date(ms).getUTCFullYear()
  const dstStarts = lastSundayUtcMs(year, 2) // March
  const dstEnds = lastSundayUtcMs(year, 9) // October
  return ms >= dstStarts && ms < dstEnds ? 7200 : 3600
}

// The Amsterdam local-midnight instant that opens civil date `dateStr` (YYYY-MM-DD), in UTC
// milliseconds - the same value scripts/seed-demo.mjs:84 computes as `endMs`. Exported for the
// pin test described above, not for any other caller: everything else in this module only ever
// needs DEMO_INSTANT_MS or DEMO_CLOCK_MS.
export function localMidnightMs(dateStr: string): number {
  const utcMidnight = Date.parse(`${dateStr}T00:00:00Z`)
  return utcMidnight - amsterdamOffsetSeconds(utcMidnight) * 1000
}

export const DEMO_INSTANT_MS = localMidnightMs(DEMO_END_DATE)

/**
 * The instant to freeze a clock to when what matters is *which calendar day it reads as*, not the
 * archive's own bookkeeping: one millisecond before DEMO_INSTANT_MS, the last millisecond of the
 * last day the seed actually wrote data for.
 *
 * DEMO_INSTANT_MS cannot serve that purpose, and did not: it is the archive's exclusive close, the
 * first instant *without* data, and DEMO_END_DATE happens to be a Monday - so a clock pinned to it
 * reads `new Date()` as a day nothing was ever seeded for, and computes the current Week as
 * DEMO_END_DATE..DEMO_END_DATE+6, entirely past the last real row. The demo's own default Day and
 * Week views opened empty because of exactly this, on data that runRebuild had genuinely written.
 * Stepping back one millisecond crosses into the last real day without needing a second date
 * string to keep in sync with DEMO_END_DATE by hand.
 */
const HALF_A_DAY_MS = 12 * 60 * 60 * 1000

export const DEMO_CLOCK_MS = DEMO_INSTANT_MS - HALF_A_DAY_MS

/**
 * The furthest the demo's clock may run: the last millisecond of that same day.
 *
 * The clock advances (installDemoClock says why - zrender's animations stall on a constant), and
 * an advancing clock anchored at the last millisecond of the day would tick straight into
 * DEMO_END_DATE, which is the first day the seed wrote nothing for: every url a page computes from
 * today would then miss the manifest, on a page that had been working a moment earlier. Starting
 * at midday and refusing to cross midnight gives a reader twelve hours on the page and no way to
 * fall off the end of the data by leaving the tab open.
 */
export const DEMO_CLOCK_CEILING_MS = DEMO_INSTANT_MS - 1
