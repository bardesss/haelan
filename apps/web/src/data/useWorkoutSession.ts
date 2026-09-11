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
