import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import type { WorkoutSessionDetail } from './useSessions.js'

/**
 * Exported so the request shape can be asserted without mounting a component, the same reason
 * sessionsPath, nightsPath and seriesPath are.
 *
 * Both segments are encoded. A session id is 32 hex characters today, so neither can currently
 * carry a slash; encoding them anyway costs one call and means a future id shape cannot turn a
 * path parameter into a path.
 */
export function sessionPath(personId: string, sessionId: string): string {
  return `/api/v1/p/${encodeURIComponent(personId)}/sessions/${encodeURIComponent(sessionId)}`
}

/**
 * One workout or night by id.
 *
 * Named useWorkoutSession, not useSession: useSession already exists in auth/session.js and means
 * the signed-in session, and every data hook in this app calls it - including this one, two lines
 * below. Two hooks called useSession would collide on import in exactly the files that need both.
 *
 * The cache key is namespaced under the person (queryKeys.resource), so it does not collide with
 * queryKeys.session() either, which is the auth session's own key.
 *
 * `sessionId` is allowed to be undefined so a page can call this before its route parameter has
 * resolved, rather than every caller having to guard the call site. Undefined disables the query,
 * exactly as a missing personId does.
 *
 * **No write in this app could invalidate this key before M8b, and that was recorded here rather
 * than fixed, because nothing in M8a could write a session in the first place.** The only
 * invalidation mechanism useAnnotations has is overlapsAffected, which decides a cached query is
 * affected by reading a string `from` and a string `to` out of its key params; this key carries
 * `{ sessionId }` and no range at all, so it can never match. Teaching overlapsAffected a
 * `sessionId` member was the other option this comment used to name, and M8b did not take it: a
 * millisecond window is not a date range, and pretending it is would make that helper answer a
 * question it does not actually know how to answer. Instead, `useWriteOverride`'s and
 * `useRemoveOverride`'s `onSuccess` in useAnnotations.ts call
 * `invalidateResource(queryClient, personId, 'session')` by name whenever the write they just made
 * touched this resource, which is how the workout page - the first browser surface able to exclude
 * a session - stops reporting a stale `excluded: false` after the reader just excluded it.
 */
export function useWorkoutSession(sessionId: string | undefined): UseQueryResult<WorkoutSessionDetail> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'session', { sessionId: sessionId ?? '' }),
    // Without both halves this requests /api/v1/p/undefined/sessions/undefined on first render,
    // which the server answers 404 for and which then sits in the cache under a key naming no
    // person and no session.
    enabled: personId !== undefined && sessionId !== undefined,
    queryFn: () => apiGet<WorkoutSessionDetail>(sessionPath(personId!, sessionId!)),
  })
}
