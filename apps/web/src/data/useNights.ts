import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { sourceParam } from '../controls/source.js'

// Mirrors packages/core/src/query/sleepNights.ts's Night, as sent by
// apps/server/src/routes/v1/tier2.ts's GET /p/:personId/sleep/nights: one row per night per
// source, carrying the session ids and stage segments that made it up, plus the start of every
// session on that date that was not part of the night. The night is the gap based group
// assembleNights picks, not every session sharing the date, so startMs and endMs are bedtime and
// wake and an afternoon nap is in `naps` rather than inside the span. This is not the shape a
// hypnogram or a bed/wake chart wants directly (bedMs, wakeMs); it is what the route actually
// answers, and the two charts that read it convert it themselves. startOffsetMinutes and
// endOffsetMinutes are the timezone offset in force at each end (see
// packages/core/src/derive/localDay.ts), not minutes since midnight, so a caller wanting a clock
// time has to combine an offset with its own instant, not read one field off this type.
export interface NightSegment {
  stage: string
  startMs: number
  endMs: number
}

export interface Night {
  localDate: string
  sourceId: string
  sessionIds: string[]
  startMs: number
  endMs: number
  startOffsetMinutes: number
  endOffsetMinutes: number
  /** Nap start times, in order. Empty means the route looked and found none, never "not asked". */
  naps: number[]
  segments: NightSegment[]
  /** The ids of this night's own source's sleep sessions the person excluded. Always present;
   *  empty is a measurement, never "not asked" (packages/core/src/query/sleepNights.ts). */
  excludedSessions: string[]
}

/**
 * Exported so the request shape, including the all sources sentinel's omission, can be asserted
 * without mounting a component. Mirrors seriesPath in useSeries.ts for the same reason.
 *
 * 'merged' is a real row value on the tier 1 `daily` rollup (MERGED_SOURCE), which is why
 * useSeries and useBaseline can send it as-is. Tier 2 reads (this route) go straight to
 * `sessions`, which carries only per-device source ids; requireSource's tier 2 call sites pass
 * no extra allowed values (packages/core/src/query/personQuery.ts), so a literal 'merged' here
 * is not a known source and the request 400s (ConfigError, mapped by
 * apps/server/src/api/envelope.ts's statusFor('config')). sourceParam only omits the all sources
 * sentinel, the same way an unset source does, which is what actually means "every device" for
 * this route; a real per-device name still passes through unchanged, and so, unguarded here,
 * would a literal 'merged'. Both callers today, Dashboard.tsx and Sleep.tsx, feed it a value that
 * has already gone through resolveSource, which never resolves to 'merged' (its own fallback is
 * the sentinel, not that literal), so the 400 case above is unreachable in practice rather than
 * prevented in this function. A future caller that skips resolveSource and passes an unresolved
 * source straight through would not be caught here.
 */
export function nightsPath(personId: string, range: { from: string, to: string, source: string }): string {
  const params = new URLSearchParams({ from: range.from, to: range.to })
  const source = sourceParam(range.source)
  if (source !== undefined) params.set('source', source)
  return `/api/v1/p/${personId}/sleep/nights?${params.toString()}`
}

/**
 * `options.enabled` is separate from `range` the way useSessions' own is: whether a caller wants
 * the request at all is not a fact about which range to fetch, and folding it into `range` would
 * put it in the cache key and cycle the entry every time it flipped.
 *
 * Its one caller so far is NightDetail, which has no date to ask for until the route parameter
 * itself has resolved: without this half of the guard, an undefined `localDate` there computes an
 * empty `{ from: '', to: '' }` range and this hook would fire that as a real request the moment
 * personId alone was ready, `?from=&to=`, rather than waiting on the route's own fact to also be
 * true.
 */
export function useNights(
  range: { from: string, to: string, source: string },
  options?: { enabled?: boolean },
): UseQueryResult<{ items: Night[], cursor: string | null }> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'sleep-nights', range),
    // Without the personId half this requests /api/v1/p/undefined/sleep/nights on first render, which
    // the server answers 404 for and which then sits in the cache under a key naming no person.
    enabled: personId !== undefined && (options?.enabled ?? true),
    queryFn: () => apiGet<{ items: Night[], cursor: string | null }>(nightsPath(personId!, range)),
  })
}
