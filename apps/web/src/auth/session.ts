import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'

export interface Session {
  personId: string
  displayName: string
  username: string
  isAdmin: boolean
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
