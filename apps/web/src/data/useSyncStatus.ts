import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'

// Mirrors the two fields of apps/server/src/sync/runner.ts's RunnerStatus this app actually reads.
// The real response carries more (reason, startedAtMs, personId, userHorizonDays, backfill), none
// of which the control row has a use for yet; naming only what is read here means that shape can
// grow for a reason unrelated to the control row without this type silently drifting out of date.
//
// rebuild joins running and lastFinishedAtMs as a field this app does read. The comment above
// still holds for the rest: naming only what is used keeps the server shape free to grow.
export interface SyncStatus {
  running: boolean
  lastFinishedAtMs: number | null
  /**
   * Whether the boot rebuild worker is running right now. Instance-wide, which is why it sits
   * beside `rebuild` rather than inside it - the server puts it in the same place, and for the
   * same reason (runner.ts's RunnerStatus). `running` above is a different thing entirely: that
   * is a sync run, which this process drives and which a person can start from the control row.
   * Nobody can start this one; it happens at boot and nothing else.
   *
   * Read by RebuildNotice, together with rebuild.awaitingRebuild, to tell "a rebuild is running
   * now" apart from "only a restart will start one" - see its own comment for why that
   * distinction matters more than it looks.
   */
  rebuildInFlight: boolean
  rebuild: {
    quarantined: boolean
    awaitingRebuild: boolean
    /**
     * Their last rebuild read archived payloads and left no readings behind. Already decided by
     * the server, which calls the same predicate the admin route does, so the two surfaces
     * cannot draw different conclusions from the same pair of columns.
     */
    producedNothing: boolean
    droppedPages: number
    lastError: string | null
    /**
     * When the last rebuild attempt failed, which RebuildNotice uses to date the quarantine line.
     * Already on the server's RebuildStatus (runner.ts); missing from this mirror until now
     * because nothing here had read it yet - the doc comment atop this interface says why that is
     * not a licence to leave a field off indefinitely, and this one really was needed the moment
     * RebuildNotice grew a date for the quarantined state.
     */
    lastErrorAtMs: number | null
    /**
     * When the last rebuild attempt committed, which RebuildNotice uses to date droppedPages and
     * producedNothing above - see RebuildStatus.lastSuccessAtMs in runner.ts for why that is "as
     * of the rebuild" and not "since the gap began". Added to runner.ts's RunnerStatus.rebuild for
     * this: the admin route already returned it, but this per-person mirror, which ControlRow
     * reads, did not.
     */
    lastSuccessAtMs: number | null
    drops: { dataType: string, reason: string, pages: number }[]
  }
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
 * One query key for this cache entry, shared with the tests that seed it. The sync button that
 * used to invalidate it (SyncControl, ControlRow's until M10) is gone: the status panel starts
 * runs now and watches them end through its own query (useStatusPanel.ts's statusKey), so this
 * entry is only read - by RebuildNotice and ControlRow - and a finished run's whole-person
 * refresh sweeps it up along with every other resource under queryKeys.person.
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
