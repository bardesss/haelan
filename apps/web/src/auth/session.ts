import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'

export interface Session {
  personId: string
  displayName: string
  username: string
  isAdmin: boolean
  timezone: string
  // The two inputs the cardio load model needs and nothing else in the app reads. Both clearable:
  // `null` is a real, storable state here, not an absent value standing in for one.
  birthDate: string | null
  sex: 'male' | 'female' | null
  // Whether this person has a usable Google connection right now - a non-revoked refresh token,
  // not merely a credentials row. A revoked person and a never-connected person both need the
  // same connect control to get moving again, so this one boolean is correct for both.
  connected: boolean
  // A row exists, was never revoked, and instance.key still cannot open it - the state a
  // restored backup leaves behind (runBackup copies the database and nothing else, so a key
  // generated on the machine that restores it is never the key that sealed this row). This was
  // argued unnecessary on the belief that every caller would recombine it back into `connected`
  // regardless, but `connected` is already correctly false for this person, and recombining loses
  // exactly the distinction a reconnect control needs to say why: "reconnect" is not the same
  // instruction as "reconnect, because the credentials a backup could not carry over need to be
  // re-consented once."
  credentialsUnreadable: boolean
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
