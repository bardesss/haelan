import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'

// Mirrors the two fields of apps/server/src/sync/runner.ts's RunnerStatus this app actually reads.
// The real response carries more (reason, startedAtMs, personId, userHorizonDays, backfill), none
// of which the control row has a use for yet; naming only what is read here means that shape can
// grow for a reason unrelated to the control row without this type silently drifting out of date.
export interface SyncStatus {
  running: boolean
  lastFinishedAtMs: number | null
}

/**
 * How often the status is re-read while a run is going.
 *
 * A run takes minutes and the status is otherwise fetched exactly once, on mount, and invalidated
 * only when a mutation succeeds: without this the button stayed disabled and the label frozen for
 * the whole run while the reader watched, and a run started anywhere else (the scheduler, another
 * tab) never showed up at all. Three seconds is cheap against a local instance and short enough
 * that "it finished" arrives while the reader is still looking.
 */
export const SYNC_POLL_MS = 3_000

/**
 * false, not zero, when nothing is running: a polling interval is a cost paid on every open tab
 * forever, and there is nothing to learn between one sync and the next.
 */
export function syncPollInterval(status: SyncStatus | undefined): number | false {
  return status?.running === true ? SYNC_POLL_MS : false
}

/**
 * One query key, shared with the sync mutation's invalidation in ControlRow: both have to agree
 * on exactly this key, or a successful run would invalidate a cache entry nothing is reading.
 * personId comes from the session, never from a parameter, for the same reason useSeries does
 * this: an account owns exactly one person, and taking it as an argument would let a caller name
 * someone else's.
 */
export function syncStatusKey(personId: string): readonly unknown[] {
  return queryKeys.resource(personId, 'sync-status')
}

/**
 * /api/sync/status is unversioned and reads the caller's own person off the session cookie
 * (routes/sync.ts's personIdFor), not the :personId path segment the versioned surface uses. The
 * personId here is only for this cache entry's key, not for the request itself.
 */
export function useSyncStatus(): UseQueryResult<SyncStatus> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: syncStatusKey(personId ?? ''),
    // Without this the hook would ask before the session resolves, the same race useSeries guards
    // against, and cache a status answer under a key naming no person.
    enabled: personId !== undefined,
    queryFn: () => apiGet<SyncStatus>('/api/sync/status'),
    refetchInterval: (query) => syncPollInterval(query.state.data),
  })
}
