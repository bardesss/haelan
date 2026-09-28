import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'

export interface Session {
  personId: string
  displayName: string
  username: string
  isAdmin: boolean
  // The home zone: what the Profile form edits and Google sync cuts its days at. Not the zone to
  // compute "today" or format a local time in - that is effectiveTimezone, below.
  timezone: string
  // The zone every "today" and every local time or date shown for the person is resolved in: the
  // phone's current zone when the person follows it and a phone has sent one, else the home zone.
  // Computed on the server (core's effectiveTimezone), so the web and the phone agree on the day.
  effectiveTimezone: string
  // The zone the companion app last synced from, null until one has, and whether today follows
  // it. Read by the Profile card only: its switch, and the line naming the zone being followed.
  currentTimezone: string | null
  followPhoneZone: boolean
  // The two inputs the cardio load model needs and nothing else in the app reads. Both clearable:
  // `null` is a real, storable state here, not an absent value standing in for one.
  birthDate: string | null
  sex: 'male' | 'female' | null
  // The nightly figure the sleep balance card measures a night against, once there is no baseline
  // of this person's own to measure against instead. Never null: 480 is a real answer for somebody
  // who has never opened Settings, and every reader of this field would otherwise have to supply
  // the same fallback for itself.
  sleepTargetMinutes: number
  // Whether the sleep balance card may measure against this person's own usual once that is
  // worth standing on. Off means the stored target above, always, for whoever wants to hold a
  // seven or eight hour line on purpose. Never null, for the same reason the target is not:
  // following the baseline is the behaviour for somebody who has never opened Settings.
  sleepUseBaseline: boolean
  // Whether the dashboard offers a Log button for this person (M9c). Off by default
  // (PeopleStore.create seeds it false), matching auth.ts's own ?? false for a pre-migration row.
  quickLogEnabled: boolean
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
    queryFn: async () => withZoneDefaults(await apiGet<Partial<Session> & Omit<Session, ZoneFields>>('/api/auth/me')),
    retry: false,
  })
}

type ZoneFields = 'effectiveTimezone' | 'currentTimezone' | 'followPhoneZone'

/**
 * A server predating the phone zone, or a demo recorded before it, answers without the three zone
 * fields; each reads as the home zone would. One place, so no reader supplies its own fallback.
 */
export function withZoneDefaults(raw: Partial<Session> & Omit<Session, ZoneFields>): Session {
  return {
    ...raw,
    effectiveTimezone: raw.effectiveTimezone ?? raw.timezone,
    currentTimezone: raw.currentTimezone ?? null,
    followPhoneZone: raw.followPhoneZone ?? true,
  }
}
