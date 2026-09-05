import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'

export interface Session {
  personId: string
  displayName: string
  username: string
  isAdmin: boolean
  timezone: string
  // Whether this person has a usable Google connection right now - a non-revoked refresh token,
  // not merely a credentials row. A revoked person and a never-connected person are different
  // stories, but the same boolean value is correct for both: neither can sync, and both need the
  // same connect control to get moving again. One field is enough because there is only one
  // action on the other side of it - a second flag distinguishing "revoked" from "never
  // connected" would just be recombined back into this same boolean by every caller.
  connected: boolean
  // The instance's own address. Compared against the browser's own origin before consent starts,
  // because a mismatch discovered mid consent has already handed Google an approval to revoke.
  baseUrl: string
}

// The person is the session's, never the URL's. An account owns exactly one person
// (accounts.person_id is unique and not null), so there is nothing to choose and nothing a
// crafted URL could change.
export function useSession() {
  return useQuery({
    queryKey: queryKeys.session(),
    queryFn: () => apiGet<Session>('/api/auth/me'),
    retry: false,
  })
}
