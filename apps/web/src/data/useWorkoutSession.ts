import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import type { WorkoutSession } from './useSessions.js'

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
 * **No write in this app can invalidate this key, and M8b has to change that.** The only
 * invalidation mechanism here is useAnnotations' overlapsAffected, which decides a cached query is
 * affected by reading a string `from` and a string `to` out of its key params. This key carries
 * `{ sessionId }` and no range at all, so it never matches and is never invalidated - it simply
 * ages out after its staleTime. Nothing in M8a can write a session, which is why this is recorded
 * rather than fixed here: the workout page M8b builds is the first browser surface that can
 * exclude a session, and the moment it does, this cached copy would keep reporting
 * `excluded: false` for up to 60 seconds while the range-keyed activity list showed the exclusion
 * immediately - two surfaces disagreeing about a correction the person just made. M8b's fix is
 * either to call `invalidateResource(queryClient, personId, 'session')` after a session write, or
 * to teach `overlapsAffected` a `sessionId` member so a session-scope write invalidates by id.
 */
export function useWorkoutSession(sessionId: string | undefined): UseQueryResult<WorkoutSession> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'session', { sessionId: sessionId ?? '' }),
    // Without both halves this requests /api/v1/p/undefined/sessions/undefined on first render,
    // which the server answers 404 for and which then sits in the cache under a key naming no
    // person and no session.
    enabled: personId !== undefined && sessionId !== undefined,
    queryFn: () => apiGet<WorkoutSession>(sessionPath(personId!, sessionId!)),
  })
}
