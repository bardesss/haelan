import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import type { HistoryBounds } from '../controls/range.js'

// Mirrors GET /api/v1/p/:personId/companion/cursors
// (apps/server/src/routes/v1/companion.ts): the history start T5.3 names and whether
// this person also walks the Google path, which is what decides if a card range may
// be clamped to it. Items travel on the same response for the phone's own delta sync;
// cards read only these two fields.
interface CursorsResponse {
  historyStartMs: number | null
  googleConnected: boolean
}

export function historyStartPath(personId: string): string {
  return `/api/v1/p/${personId}/companion/cursors?platform=android`
}

/**
 * The wire answer narrowed to what the clamp reads, so a body with nothing
 * numeric in it is no history rather than an invalid date downstream.
 */
export function normalizeHistoryStart(body: CursorsResponse): HistoryBounds {
  return {
    historyStartMs: typeof body.historyStartMs === 'number' ? body.historyStartMs : null,
    googleConnected: body.googleConnected === true,
  }
}

/**
 * When this person's phone history starts, once per hour. The start is the oldest
 * companion window end the archive holds, so it only ever moves earlier on a first
 * sync and never after: an hour of cache costs nothing and saves every card its own
 * request, since all of them read through usePageControls.
 */
export function useHistoryStart(): UseQueryResult<HistoryBounds> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'history-start'),
    // Same race useSeries guards: asking before the session resolves would cache an
    // answer under a key naming no person.
    enabled: personId !== undefined,
    staleTime: 60 * 60 * 1000,
    queryFn: async (): Promise<HistoryBounds> => {
      const body = await apiGet<CursorsResponse>(historyStartPath(personId!))
      return normalizeHistoryStart(body)
    },
  })
}
