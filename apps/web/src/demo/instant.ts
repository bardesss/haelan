/**
 * The instant the demo pins both clocks to: the recorder's server clock (`demo/capture/server.ts`)
 * and, later, the browser's own clock (Task 5's demo entry). Both sides answer requests against
 * this same "now" so the recorded manifest and the replayed demo can never disagree about what
 * "today" means - a live clock on either side would make the default range depend on which day
 * someone happened to run the capture or open the demo.
 *
 * `scripts/seed-demo.mjs` is the authority for this arithmetic: it anchors the seeded archive's
 * exclusive end at `localMidnightMs(DEMO_END_DATE)` (see its own comment, and
 * `packages/core/src/testing/seed.ts`, for why a *local* Amsterdam midnight is used instead of a
 * UTC one). That function lives in the core package's testing folder, which imports `node:crypto`
 * and a data generator this browser-bound module must never pull into the demo bundle, so the
 * handful of lines it needs are reproduced here rather than imported. Keep the two in sync: if
 * either changes, the other has to change with it, or the demo's default range ends up one day off
 * its own data.
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
// milliseconds - the same value scripts/seed-demo.mjs:84 computes as `endMs`.
function localMidnightMs(dateStr: string): number {
  const utcMidnight = Date.parse(`${dateStr}T00:00:00Z`)
  return utcMidnight - amsterdamOffsetSeconds(utcMidnight) * 1000
}

export const DEMO_INSTANT_MS = localMidnightMs(DEMO_END_DATE)
