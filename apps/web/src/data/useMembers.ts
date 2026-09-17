import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { useSession } from '../auth/session.js'

// Mirrors MemberRow in apps/server/src/routes/members.ts, which the route sends whole, the same
// choice useSourceNames.ts makes for NamedSource and for the same reason: apps/web imports only
// @haelan/core's browser safe subpaths, and this shape does not come from @haelan/core at all, so
// there is nothing to import even in principle -- it is declared once, by value, on each side.
export type MemberState = 'active' | 'invited' | 'disabled' | 'expired'

export interface MemberRow {
  personId: string
  displayName: string
  timezone: string
  accountId: string | null
  username: string | null
  isAdmin: boolean
  state: MemberState
  inviteId: string | null
  /** Null until this account signs in once, and on every row that has no account yet. */
  lastLoginAtMs: number | null
  /** Null for a row with no account: an invited person syncs nothing, and "never synced" would
   *  read as a fault rather than as the absence of one. */
  sync: SyncFreshness | null
}

/** Mirrors SyncFreshness in packages/core/src/store/syncState.ts, by value like MemberRow above.
 *  The floor rather than the ceiling: see that store's own comment for why a maximum would read
 *  "synced two minutes ago" while half the person's data had been failing for a week. */
export interface SyncFreshness {
  oldestSuccessAtMs: number | null
  neverSucceeded: number
  failing: number
  due: number
}

interface MembersResponse { items: MemberRow[] }

/**
 * What POST /api/members answers. `token` is the one and only place this value is ever readable:
 * the route stores a hash of it, never the token itself (apps/server/src/routes/members.ts's own
 * comment), so there is no GET this app could retry to recover it. Members.tsx keeps this in
 * component state alone, never in a query cache entry, so it disappears the moment the panel
 * showing it closes, exactly as it disappears from the server the moment this response is sent.
 */
export interface InviteResult {
  personId: string
  inviteId: string
  token: string
  expiresAtMs: number
}

/**
 * Shared by the query and every mutation's invalidation, so all five agree on one cache entry.
 * Unlike sourceNamesKey and syncStatusKey, this carries no personId: /api/members lists every
 * person in the household regardless of who is asking (app.requireAdmin is what restricts who may
 * ask at all), so keying it to the caller's own person would still be one entry per caller, just
 * under a key naming the wrong thing.
 */
export function membersKey(): readonly unknown[] {
  return ['members']
}

/**
 * Every person in the household and the account state each one is in. Admin only: the route
 * answers 'forbidden' to anyone else, which is why Settings.tsx mounts this section at all only
 * when session.data?.isAdmin is true rather than relying on this hook to hide its own failure.
 */
export function useMembers(): UseQueryResult<MembersResponse> {
  const session = useSession()
  return useQuery({
    queryKey: membersKey(),
    // Same race useSourceNames and useSyncStatus guard against, though for a different reason
    // here: the request needs no id of the caller's own, but asking before the session resolves
    // risks a race with the sign-in redirect itself, the same moment a stray request from a page
    // that has not decided who is looking yet would land.
    enabled: session.data !== undefined,
    queryFn: () => apiGet<MembersResponse>('/api/members'),
  })
}

/**
 * One field. The invite used to carry a timezone too, which the admin guessed on the member's
 * behalf and the acceptance screen could only read back; the person row now takes the inviting
 * admin's own zone, and the member changes it in their own Profile card (useProfile.ts).
 */
export function useInviteMember(): UseMutationResult<InviteResult, ApiError, { displayName: string }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => apiSend<InviteResult>('POST', '/api/members', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: membersKey() })
    },
  })
}

export function useDisableMember(): UseMutationResult<{ state: MemberState }, ApiError, { accountId: string }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => apiSend<{ state: MemberState }>('POST', `/api/members/${input.accountId}/disable`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: membersKey() })
    },
  })
}

export function useEnableMember(): UseMutationResult<{ state: MemberState }, ApiError, { accountId: string }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => apiSend<{ state: MemberState }>('POST', `/api/members/${input.accountId}/enable`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: membersKey() })
    },
  })
}

export function useRevokeInvite(): UseMutationResult<void, ApiError, { inviteId: string }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => apiSend<void>('DELETE', `/api/members/invites/${input.inviteId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: membersKey() })
    },
  })
}
