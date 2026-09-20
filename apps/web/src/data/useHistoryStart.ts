import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import type { HistoryBounds } from '../controls/range.js'

// Mirrors GET /api/v1/p/:personId/companion/cursors
// (apps/server/src/routes/v1/companion.ts): the history start and whether
// this person also walks the Google path, which is what decides if a card range may
// be clamped to it. Items travel on the same response for the phone's own delta sync;
// cards read only these two fields.
interface CursorsResponse {
  historyStartMs: number | null
  googleConnected: boolean
  items?: { dataTypeId: string, lastWindowEndMs: number | null, lastIngestAtMs: number | null }[]
}

/**
 * The clamp's two fields plus when the phone last delivered anything.
 *
 * Wider than [HistoryBounds] rather than a second query: the cursors route already answers all
 * three in one body, and the items were being fetched and dropped on the floor. `clampFromToHistory`
 * still takes the narrower type, which this structurally satisfies, so the range code stays unaware
 * of recency and the recency code stays unaware of clamping.
 */
export interface PhoneHistory extends HistoryBounds {
  /** The newest ingest across every type, or null when the phone has never sent. */
  lastIngestAtMs: number | null
}

export function historyStartPath(personId: string): string {
  return `/api/v1/p/${personId}/companion/cursors?platform=android`
}

/**
 * The wire answer narrowed to what the clamp reads, so a body with nothing
 * numeric in it is no history rather than an invalid date downstream.
 */
export function normalizeHistoryStart(body: CursorsResponse): PhoneHistory {
  // The newest delivery across every type, not per type: the question the screen asks is whether
  // the phone is still reaching this instance at all, and a phone that sent steps an hour ago is
  // reaching it whether or not weight has moved in a month. A per type staleness is a different,
  // narrower question and would need a different surface than one line.
  const ingests = (Array.isArray(body.items) ? body.items : [])
    .map((item) => item.lastIngestAtMs)
    .filter((at): at is number => typeof at === 'number')
  return {
    historyStartMs: typeof body.historyStartMs === 'number' ? body.historyStartMs : null,
    googleConnected: body.googleConnected === true,
    lastIngestAtMs: ingests.length > 0 ? Math.max(...ingests) : null,
  }
}

/**
 * What this person's phone has sent, once per hour. Two facts with different shelf lives, and the
 * hour is chosen for the shorter one.
 *
 * The start is the oldest companion window end the archive holds, so it only ever moves earlier on
 * a first sync and never after: it would be correct cached for a day.
 *
 * `lastIngestAtMs` does move, and an hour of cache means the staleness line can be an hour behind
 * the truth. That is proportionate rather than sloppy: the phone's own schedule is twelve hourly
 * (SyncSchedule.policy), so the only thing this line has to distinguish is hours from days, and it
 * does that with an hour of slack. A line that had to be accurate to the minute would need its own
 * query and a much shorter stale time, and nothing reads it that closely.
 */
export function useHistoryStart(): UseQueryResult<PhoneHistory> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'history-start'),
    // Same race useSeries guards: asking before the session resolves would cache an
    // answer under a key naming no person.
    enabled: personId !== undefined,
    staleTime: 60 * 60 * 1000,
    queryFn: async (): Promise<PhoneHistory> => {
      const body = await apiGet<CursorsResponse>(historyStartPath(personId!))
      return normalizeHistoryStart(body)
    },
  })
}
