import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'

export interface Session {
  personId: string
  displayName: string
  username: string
  isAdmin: boolean
  timezone: string
  // Whether this person has Google credentials at all, revoked or not - the reconnect banner
  // needs to tell "revoked" apart from "never connected", both of which have to render as
  // something other than a plain connect prompt.
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
