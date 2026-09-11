import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import { apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'

/**
 * What PUT /api/profile answers: the three fields as they were stored, and whether the timezone
 * write left this person's derived rows waiting on a rebuild.
 *
 * `rebuildPending` is a fact about the instance rather than about the request, which is why it is
 * read off the response rather than guessed at from what the panel sent: the route only marks a
 * rebuild when the stored zone actually moved, and a form that submits all three fields every time
 * cannot tell the difference from its own side.
 */
export interface SavedProfile {
  displayName: string
  username: string
  timezone: string
  rebuildPending: boolean
}

export interface ProfileEdit {
  displayName: string
  username: string
  timezone: string
}

/**
 * The caller's own name, username and timezone. No query beside it: GET /api/auth/me already
 * carries all three, and a second route answering the same values is a second thing to keep in
 * step. That is also why this invalidates the session key rather than one of its own - the Shell,
 * the rail and every day boundary the browser resolves read the session, and a rename that left
 * them showing the old name would look like the save had failed.
 */
export function useSaveProfile(): UseMutationResult<SavedProfile, ApiError, ProfileEdit> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => apiSend<SavedProfile>('PUT', '/api/profile', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.session() })
    },
  })
}

/**
 * Replaces the caller's own password, current one included.
 *
 * Invalidates nothing: no field any screen shows changes, and the session survives on purpose (the
 * route's own comment on why). An invalidation here would only make the page flicker to say
 * nothing happened.
 *
 * A wrong current password comes back as an ApiError of kind 'forbidden', not 'unauthorized' -
 * which matters more than it looks, because queryClient.tsx signs the reader out on a 401. Getting
 * your own password wrong must not end the session you were using to change it.
 */
export function useChangePassword(): UseMutationResult<void, ApiError, { currentPassword: string, newPassword: string }> {
  return useMutation({
    mutationFn: (input) => apiSend<void>('PUT', '/api/profile/password', input),
  })
}

/**
 * An admin setting another member's password, for the member who is locked out of theirs and whom
 * this instance has no way to mail a link to.
 *
 * Invalidates nothing for the same reason the one above does not: GET /api/members reports state,
 * not passwords, so no row on the list changes. Members.tsx says so in its own result line instead.
 */
export function useResetMemberPassword(): UseMutationResult<void, ApiError, { accountId: string, password: string }> {
  return useMutation({
    mutationFn: (input) => apiSend<void>('POST', `/api/members/${input.accountId}/password`, { password: input.password }),
  })
}
