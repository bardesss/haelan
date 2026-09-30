import { useEffect, useRef } from 'react'
import { hashKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { StatusPanel, StatusSync } from '@haelan/core/status-panel'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { requirePersonId } from './useAnnotations.js'
import { sourceNamesKey } from './useSourceNames.js'

// The response type is core's own, imported through the browser-safe @haelan/core/status-panel
// subpath rather than mirrored here the way useSyncStatus.ts mirrors RunnerStatus. That mirror
// exists because RunnerStatus lives in the server app, which this bundle cannot import at all;
// StatusPanel lives in an import-free core module that composeStatus builds the answer from, so a
// copy here would be a second opinion about a shape that already has a single owner - and the
// panel reads every field of it, so "name only what is read" would name all of them anyway.
export type { StatusPanel, StatusConnection, StatusDevice, StatusSync, StatusFailure, ConnectionKind, ConnectionProblem } from '@haelan/core/status-panel'

/**
 * One key for the status panel's query, its own invalidation after a click, and the whole-person
 * refresh's exclusion below. Under queryKeys.person like every resource, so a sign-out or a
 * person switch clears it with everything else.
 */
export function statusKey(personId: string): readonly unknown[] {
  return queryKeys.resource(personId, 'status')
}

/**
 * How often the status is re-read while a run is going: the same three seconds useSyncStatus has
 * always polled at, for the reason its SYNC_POLL_MS comment gives.
 */
export const STATUS_POLL_MS = 3_000

/** How often the status is re-read while idle, so a run the poll never caught still surfaces. */
const IDLE_REFETCH_MS = 5 * 60_000

/**
 * Everything a finished run can have changed for this person, which is everything cached under
 * their prefix - the same whole-person invalidation useSetSourcePriority makes after a re-rank,
 * and for the same reason: a sync writes rows every card reads.
 *
 * Except the status panel itself, which lives under that prefix too (it is a queryKeys.resource)
 * and has just been answered: it is the query that reported the run ending. Invalidating it would
 * refetch it at once for nothing, and on a run that ends mid-poll it would do so every time.
 * Compared by hash rather than by position, so a change to how resource keys are built cannot
 * quietly turn this exclusion into a no-op.
 *
 * Moved here from SyncControl, which the status icon replaced. The exclusion used to name the
 * sync status; that query is still read (RebuildNotice, ControlRow) but no longer the one that
 * watches a run end, so refreshing it along with everything else is right.
 */
function refreshPersonData(queryClient: QueryClient, personId: string): void {
  const ownHash = hashKey(statusKey(personId))
  void queryClient.invalidateQueries({
    queryKey: queryKeys.person(personId),
    predicate: (query) => query.queryHash !== ownHash,
  })
}

/**
 * /api/status answers for the caller's own person off the session cookie, like /api/sync/status
 * does; personId is only this cache entry's key. Enabled only once the session resolves, the same
 * race useSeries and useSyncStatus guard against: an answer cached under a key naming no person.
 */
export function useStatusPanel(): UseQueryResult<StatusPanel> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: statusKey(personId ?? ''),
    enabled: personId !== undefined,
    queryFn: () => apiGet<StatusPanel>('/api/status'),
    // Poll while a run goes and while the cooldown counts down, so "Synced just now" becomes
    // the Sync button again without a reload; idle otherwise.
    //
    // The cooldown wait is one read timed to land just after it ends (plus a quarter second of
    // slack for the server's own clock), not a three-second poll: nothing changes in between, and
    // the cap keeps a server that ever answered a silly number from parking the tab for an hour.
    refetchInterval: (query) => {
      const sync = query.state.data?.sync
      if (sync?.running === true) return STATUS_POLL_MS
      if ((sync?.cooldownRemainingMs ?? 0) > 0) return Math.min(sync!.cooldownRemainingMs + 250, 60_000)
      // Idle otherwise, but not silent: a scheduled run this tab never saw start and finish (no
      // click here, no poll catching 'running') would otherwise leave the panel and every chart
      // showing stale data until the next reload. Five minutes, the same idle refresh the rest of
      // the app already accepts elsewhere.
      return IDLE_REFETCH_MS
    },
  })
}

/**
 * The status as the shell already reads it, for a second place that shows the sync (the workout
 * page's "Sync now"): the same query and key as useStatusPanel, but with no timer of its own and
 * no refetch on mount or focus while it holds an answer, so it adds no reads beside the shell's
 * poll. It still refetches when invalidated, as useRunSync does after a press.
 */
export function useStatusSnapshot(): UseQueryResult<StatusPanel> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: statusKey(personId ?? ''),
    enabled: personId !== undefined,
    queryFn: () => apiGet<StatusPanel>('/api/status'),
    staleTime: Infinity,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  })
}

/**
 * What a sync button says and whether it can be pressed, the one rule every sync button follows
 * (the status panel's and the workout page's). Three disabled states, each for its own reason.
 * Running: the server would answer 409. Pending: the press is in flight and a second would race
 * it. Cooldown: the server refuses a run inside a minute of the last one (429), and "Synced just
 * now" is the true thing to say about that minute - a live button that is certain to be refused
 * is a control that lies. The cooldown is the status's alone, never a remembered 429: a refused
 * press re-reads the status (useRunSync's onError), and the button comes back when that says the
 * minute is over. `label` is the key under `status.sync`.
 */
export function syncButtonState(sync: StatusSync | null, pending: boolean): { label: 'run' | 'running' | 'cooldown', disabled: boolean } {
  const running = sync?.running === true
  const coolingDown = !running && (sync?.cooldownRemainingMs ?? 0) > 0
  return { label: running ? 'running' : coolingDown ? 'cooldown' : 'run', disabled: running || pending || coolingDown }
}

/**
 * What a refused press says, a key under `status.sync`, or null. 429 is the server's minute of
 * cooldown after a run, which means a run just finished: the true answer is "Synced just now", not
 * a failure - and the button already says exactly that (syncButtonState), so a 429 has no line of
 * its own and the button carries the cooldown alone. 409 is a run already going, or the instance
 * shutting down; either way nothing new was started by this press. Anything else did not start.
 */
export function syncRefusal(runSync: Pick<UseMutationResult<unknown, ApiError, void>, 'isError' | 'error'>): 'alreadyRunning' | 'didNotStart' | null {
  if (!runSync.isError) return null
  const status = runSync.error?.status
  return status === 429 ? null : status === 409 ? 'alreadyRunning' : 'didNotStart'
}

/**
 * Starting a Google sync by hand.
 *
 * tryStart on the server takes the mutex synchronously and answers before the run finishes
 * (routes/sync.ts, runner.ts's tryStart), so this mutation's own pending state is only the moment
 * of that one request, not the run it kicks off. The status's sync.running, refreshed by the
 * invalidation below, is what actually disables the button for the run's whole duration.
 *
 * Awaited, and then read back, for the one run the transition in useRefreshOnSyncFinish cannot
 * see: one with so little to fetch that it has finished before this re-read gets its answer. The
 * status then goes from idle to idle, nothing is ever observed running, and without this the click
 * would refresh the panel and nothing else. Idle on the re-read can only mean finished, not
 * not-yet-started, because tryStart holds the mutex before the 202 is sent. Still running is left
 * to the transition, which will see it end.
 *
 * The error is left as the ApiError apiSend threw, status intact, because the panel says three
 * different things for it: 429 is the server's sixty-second cooldown (a run just finished, so
 * "Synced just now" is the true answer), 409 a run already going, anything else a real failure.
 */
export function useRunSync(): UseMutationResult<unknown, ApiError, void> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation<unknown, ApiError, void>({
    mutationFn: () => apiSend('POST', '/api/sync/run'),
    onSuccess: async () => {
      if (personId === undefined) return
      await queryClient.invalidateQueries({ queryKey: statusKey(personId) })
      if (queryClient.getQueryData<StatusPanel>(statusKey(personId))?.sync?.running === false) {
        refreshPersonData(queryClient, personId)
      }
    },
    // A 429 means the server's cooldown refused the click - cooldownRemainingMs on the status
    // this panel is already showing is now stale (it read as over, or the click would not have
    // been offered), so re-read it rather than leave the button enabled for a click that will
    // only be refused again.
    onError: async (error) => {
      if (personId === undefined || error.status !== 429) return
      await queryClient.invalidateQueries({ queryKey: statusKey(personId) })
    },
  })
}

/**
 * A run finishing is what makes every chart on the page stale; this is what says so.
 *
 * Keyed on the status going from running to idle rather than on the click, because the click is
 * only one of three ways a run starts: the scheduler and another tab start them too, and the poll
 * in useStatusPanel sees all three end the same way. A hook of its own rather than inside
 * useStatusPanel because the panel content and the icon may both read that query, and every
 * caller would refresh the page once each; StatusControl, which renders exactly once in the shell
 * and is mounted whether or not its panel is open, is the one caller.
 *
 * Keyed on lastFinishedAtMs rising rather than on running going true then false: the five-minute
 * idle poll above can land after a scheduled run has both started and finished, so this tab never
 * observes running === true for it at all, and a running-to-idle transition would miss it
 * entirely. lastFinishedAtMs moving forward is true of every run that ends, seen or not.
 *
 * The ref starts at whatever the first render saw, so mounting onto an already-finished status is
 * not a transition, and neither is the same finish time answered again.
 */
export function useRefreshOnSyncFinish(status: StatusPanel | undefined): void {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  const lastFinishedAtMs = status?.sync?.lastFinishedAtMs
  const previous = useRef(lastFinishedAtMs)
  // The first effect run is always "the first read": whatever value mount happened to see is a
  // baseline, never a rise, no matter what it is (null or an old real timestamp alike).
  const seen = useRef(false)
  useEffect(() => {
    const was = previous.current
    previous.current = lastFinishedAtMs
    if (!seen.current) { seen.current = true; return }
    if (lastFinishedAtMs != null && (was == null || lastFinishedAtMs > was) && personId !== undefined) {
      refreshPersonData(queryClient, personId)
    }
  }, [lastFinishedAtMs, personId, queryClient])
}

/**
 * Showing or hiding one source in the status panel, or handing it back to the default rule
 * (visible: null). A DELETE for the last rather than a PUT of null, because "no choice" is the
 * absence of a row on the server, not a third value stored in one.
 *
 * Both the panel and the source list read the choice, so both are refreshed: sourceNamesKey is
 * the parent of the activity listing's key, which is where panelChoice arrives.
 */
export function useSetPanelChoice(): UseMutationResult<{ visible: boolean | null }, ApiError, { sourceId: string, visible: boolean | null }> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => {
      const id = requirePersonId(personId)
      const path = `/api/v1/p/${id}/sources/${input.sourceId}/panel`
      return input.visible === null
        ? apiSend<{ visible: boolean | null }>('DELETE', path)
        : apiSend<{ visible: boolean | null }>('PUT', path, { visible: input.visible })
    },
    onSuccess: () => {
      if (personId === undefined) return
      void queryClient.invalidateQueries({ queryKey: statusKey(personId) })
      void queryClient.invalidateQueries({ queryKey: sourceNamesKey(personId) })
    },
  })
}
