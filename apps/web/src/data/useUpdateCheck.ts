import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { useSession } from '../auth/session.js'

/** What GET and PUT /api/settings/update both answer. Mirrors UpdateCheck in
 *  apps/server/src/updates.ts, declared by value the way MemberRow is: that type lives in the
 *  server app, which this bundle cannot reach even in principle. */
export interface UpdateStatus {
  /** Whether this instance is allowed to ask GitHub at all. False is the default for every instance. */
  enabled: boolean
  /** The newest published release, or null when nothing is known - including whenever `enabled` is false. */
  latest: string | null
  checkedAtMs: number | null
  /** False when the instance could not reach GitHub. Not an error: a firewall is a valid answer. */
  reachable: boolean
}

/** One cache entry for the whole instance, like instanceUrlKey: this is not scoped to a reader. */
export function updateStatusKey(): readonly unknown[] {
  return ['update-status']
}

/**
 * Whether a newer release exists.
 *
 * `staleTime` an hour, and it is not an optimisation: the server already caches the answer for six
 * hours, so refetching sooner would ask this instance a question it will answer from memory - and
 * a component that re-rendered on every focus change would do it constantly. An hour keeps the
 * browser's own idea of freshness under the server's without racing it.
 */
export function useUpdateStatus(): UseQueryResult<UpdateStatus, ApiError> {
  const session = useSession()
  return useQuery({
    queryKey: updateStatusKey(),
    enabled: session.data !== undefined,
    staleTime: 60 * 60 * 1000,
    queryFn: () => apiGet<UpdateStatus>('/api/settings/update'),
  })
}

/**
 * Turns the check on or off. Admin only: the route answers 'forbidden' to anyone else, which is
 * why the switch is rendered only for an admin -- the same split useInstanceUrl.ts documents.
 *
 * The answer is written straight into the cache rather than invalidated. The route answers with
 * the state it just wrote, including the fresh check when it was switched on, so refetching would
 * ask the same question again for the same answer while the reader watched a spinner.
 */
export function useSetUpdateCheck(): UseMutationResult<UpdateStatus, ApiError, { enabled: boolean }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => apiSend<UpdateStatus>('PUT', '/api/settings/update', input),
    onSuccess: (status) => {
      queryClient.setQueryData(updateStatusKey(), status)
    },
  })
}

/**
 * Whether `latest` names a release newer than `current`.
 *
 * Numeric, part by part, rather than a string comparison: "1.9.0" sorts above "1.10.0" as text,
 * which would tell a household on the newer release to upgrade to the older one for as long as the
 * minor number had two digits. Anything either side cannot parse as numbers - a tag with a suffix,
 * an unreplaced build constant - answers false, because "I cannot tell" and "you are behind" are
 * different claims and only one of them belongs on a card.
 */
export function isNewer(latest: string | null, current: string): boolean {
  if (latest === null) return false
  const want = parts(latest)
  const have = parts(current)
  if (want === null || have === null) return false
  for (let at = 0; at < 3; at += 1) {
    if (want[at]! > have[at]!) return true
    if (want[at]! < have[at]!) return false
  }
  return false
}

/** Exactly three whole numbers, or nothing. */
function parts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}
