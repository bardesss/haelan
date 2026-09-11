import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { useSession } from '../auth/session.js'

/**
 * Mirrors CALLBACK_PATH in apps/server/src/oauth/redirectUri.ts, declared by value the same way
 * MemberRow is (useMembers.ts): this constant lives in the server app, which the browser bundle
 * cannot reach even in principle.
 *
 * Copied rather than asked for, because there is nothing left to ask. The wizard reads its
 * candidates from GET /api/setup/redirect-uris, and the setup gate closes every /api/setup route
 * the moment setup is done, which is the only moment this panel exists in.
 */
const CALLBACK_PATH = '/oauth/callback'

/** What GET and PUT /api/settings/instance-url both answer. */
export interface InstanceUrl {
  baseUrl: string
  redirectUri: string
}

/**
 * The redirect a given address would produce, for the line the panel shows before anything is
 * saved. redirectUriFor's own trailing slash trim and nothing else, so the string somebody is
 * told to register in the Google console is the string the route will store and every later
 * consent will send. An approximation here would be worse than no preview: it would be registered,
 * and it would still mismatch.
 */
export function redirectUriPreview(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed === '' ? '' : `${trimmed}${CALLBACK_PATH}`
}

/**
 * Shared by the query and the mutation's invalidation, so both agree on one cache entry. No
 * personId, for the reason membersKey (useMembers.ts) carries none: this is the one address the
 * whole instance answers on, not anything scoped to the caller.
 */
export function instanceUrlKey(): readonly unknown[] {
  return ['instance-url']
}

/**
 * The address this instance believes it is reachable at, and the OAuth redirect derived from it.
 * requireSession only, unlike the PUT below: the GET tells a member the address they already
 * typed into their browser.
 */
export function useInstanceUrl(): UseQueryResult<InstanceUrl, ApiError> {
  const session = useSession()
  return useQuery({
    queryKey: instanceUrlKey(),
    enabled: session.data !== undefined,
    queryFn: () => apiGet<InstanceUrl>('/api/settings/instance-url'),
  })
}

/**
 * Moves the instance. Admin only: the route answers 'forbidden' to anyone else, which is why
 * Settings.tsx mounts the section at all only when session.data?.isAdmin is true -- the same split
 * useMembers.ts documents for its own route.
 *
 * An address Google will not register is a rejection, not a decline: the route answers 400 with
 * the rule that rules it out, so this rejects with an ApiError whose message is that rule and the
 * panel shows it rather than a sentence of its own invention.
 */
export function useSaveInstanceUrl(): UseMutationResult<InstanceUrl, ApiError, { baseUrl: string }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => apiSend<InstanceUrl>('PUT', '/api/settings/instance-url', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: instanceUrlKey() })
    },
  })
}
