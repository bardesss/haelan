// One formatter per timezone, kept, rather than one per call.
//
// `en-CA` because it yields ISO-ordered parts, which is what every caller here wants a local date
// to look like. The locale is fixed on purpose: a date this produces is a storage key - the
// archive's day-aligned dedup key, a `daily` row's date - and keys must not follow whoever's
// machine is running the process.
//
// The cache is the point. `startOfLocalDay` in windows.ts finds local midnight by walking back an
// hour at a time and then bisecting the boundary hour to the minute, which is about thirty of
// these calls for one window, and a backfill fetches thousands of windows. Profiled on 2026-09-09
// against a sprint of 4,680 windows, constructing these formatters was 59% of the run - gzip was
// 1.8% of it and every SQLite call together about 15%. Memoising took the same run 4.6x faster.
// Construction is what costs; formatting an instant with a formatter that already exists is cheap.
//
// Unbounded, deliberately. The keys are IANA zone names that reached us through a person's stored
// timezone, which `setup.ts` validates before storing, so the set is bounded by how many people a
// household has. A cache that evicted would reintroduce the cost it exists to remove on exactly
// the alternating access pattern a two-person household produces.
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached) return cached
  const built = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  formatters.set(timeZone, built)
  return built
}

/**
 * The civil date at an instant, in one person's zone, as `YYYY-MM-DD`.
 *
 * Two people in different zones asking about the same instant must get different dates, which is
 * what makes a per-person day-aligned key mean anything. An invalid zone throws from
 * `Intl.DateTimeFormat` itself, on the first call for that zone rather than every call - the same
 * error, from the same place, since nothing here catches it.
 */
export function localDateOf(ms: number, timeZone: string): string {
  return formatterFor(timeZone).format(new Date(ms))
}

// How far `timeZone` is ahead of UTC at the instant `utcMs`, in milliseconds: the zone's own wall
// clock read back as if it were UTC, minus the instant itself.
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)!.value)
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
  return wall - Math.floor(utcMs / 1000) * 1000
}

/**
 * The instant local midnight opens `date` (YYYY-MM-DD) in `timeZone`. The offset is read twice,
 * the second time at the first answer, so a day whose offset changes during it (the clocks going
 * forward or back) is answered with the offset midnight itself was in.
 *
 * Same algorithm as `apps/web/src/pages/dashboard/glanceText.ts`'s own `localMidnightMs`, which
 * this mirrors rather than imports from: the web app's copy exists for a browser reading its own
 * timezone, and this one for core's server-side readers, which have no reason to depend on
 * `apps/web`.
 */
export function localMidnightMs(date: string, timeZone: string): number {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`)
  const guess = utcMidnight - zoneOffsetMs(utcMidnight, timeZone)
  return utcMidnight - zoneOffsetMs(guess, timeZone)
}
