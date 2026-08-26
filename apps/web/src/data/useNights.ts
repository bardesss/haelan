import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'

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

export function useNights(
  range: { from: string, to: string, source: string },
): UseQueryResult<{ items: Night[], cursor: string | null }> {
  const session = useSession()
  const personId = session.data?.personId
  const params = new URLSearchParams({ from: range.from, to: range.to })
  // 'merged' is a real row value on the tier 1 `daily` rollup (MERGED_SOURCE), which is why
  // useSeries and useBaseline send it as-is. Tier 2 reads (this route) go straight to `sessions`,
  // which carries only per-device source ids; requireSource's tier 2 call sites pass no extra
  // allowed values (packages/core/src/query/personQuery.ts), so a literal 'merged' here is not a
  // known source and the request 400s (ConfigError, mapped by apps/server/src/api/envelope.ts's
  // statusFor('config')). Omitting it, the same way an unset source does, is what actually means
  // "every device" for this route.
  if (range.source !== 'merged') params.set('source', range.source)
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'sleep-nights', range),
    // Without this the hook would request /api/v1/p/undefined/sleep/nights on first render, which
    // the server answers 404 for and which then sits in the cache under a key naming no person.
    enabled: personId !== undefined,
    queryFn: () => apiGet<{ items: Night[], cursor: string | null }>(
      `/api/v1/p/${personId!}/sleep/nights?${params.toString()}`,
    ),
  })
}
