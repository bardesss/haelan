import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { sourceParam } from '../controls/source.js'

// Mirrors packages/core/src/query/sleepNights.ts's Night, as sent by
// apps/server/src/routes/v1/tier2.ts's GET /p/:personId/sleep/nights: one row per night per
// source, carrying the session ids and stage segments that made it up. This is not the shape a
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
  segments: NightSegment[]
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
 * would a literal 'merged'. Dashboard is this hook's only caller today and always feeds it a
 * value that has already gone through resolveSource, which never resolves to 'merged' (its own
 * fallback is the sentinel, not that literal), so the 400 case above is unreachable in practice
 * rather than prevented in this function. A future caller that skips resolveSource and passes an
 * unresolved source straight through would not be caught here.
 */
export function nightsPath(personId: string, range: { from: string, to: string, source: string }): string {
  const params = new URLSearchParams({ from: range.from, to: range.to })
  const source = sourceParam(range.source)
  if (source !== undefined) params.set('source', source)
  return `/api/v1/p/${personId}/sleep/nights?${params.toString()}`
}

export function useNights(
  range: { from: string, to: string, source: string },
): UseQueryResult<{ items: Night[], cursor: string | null }> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'sleep-nights', range),
    // Without this the hook would request /api/v1/p/undefined/sleep/nights on first render, which
    // the server answers 404 for and which then sits in the cache under a key naming no person.
    enabled: personId !== undefined,
    queryFn: () => apiGet<{ items: Night[], cursor: string | null }>(nightsPath(personId!, range)),
  })
}
