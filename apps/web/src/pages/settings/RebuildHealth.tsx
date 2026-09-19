import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { useTranslation } from '../../i18n/index.js'
import { useSession } from '../../auth/session.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { RebuildNotice } from '../../components/RebuildNotice.js'
import { apiGet } from '../../api/client.js'
import type { ApiError } from '../../api/client.js'
import { queryKeys } from '../../api/queryKeys.js'

// Mirrors the per-person shape GET /api/settings/rebuild answers (routes/maintenance.ts's own doc
// comment on registerMaintenance explains why every person in stores.people appears here, even one
// rebuildState holds no row for at all). apps/web imports only @haelan/core's browser safe
// subpaths, never its root export -- the same reason DatabaseBloat is redeclared rather than
// imported in useMaintenance.ts -- so this is not RebuildStateRow itself.
export interface RebuildPersonState {
  personId: string
  displayName: string
  quarantined: boolean
  awaitingRebuild: boolean
  droppedPages: number
  lastErrorAtMs: number | null
  lastError: string | null
  lastSuccessAtMs: number | null
  consecutiveFailures: number
  drops: { dataType: string, reason: string, pages: number }[]
}

interface RebuildHealthStatus {
  people: RebuildPersonState[]
  /**
   * Whether the boot rebuild worker is running right now, sent once for the whole household
   * because one worker rebuilds all of it in a single pass. On the envelope rather than on each
   * RebuildPersonState above, which is where the route puts it and for the same reason: two rows
   * of one response must not be able to disagree about whether a rebuild is going.
   */
  rebuildInFlight: boolean
}

/**
 * The household's view of the same state /api/sync/status carries one person at a time. Admin
 * only, the same split Maintenance.tsx documents for its own route: the route answers 'forbidden'
 * to anyone else, and Settings.tsx mounts this section at all only when session.data?.isAdmin is
 * true, rather than relying on this hook to hide its own failure.
 */
export function useRebuildHealth(): UseQueryResult<RebuildHealthStatus, ApiError> {
  const session = useSession()
  return useQuery<RebuildHealthStatus, ApiError>({
    queryKey: queryKeys.rebuildHealth(),
    enabled: session.data !== undefined,
    queryFn: () => apiGet<RebuildHealthStatus>('/api/settings/rebuild'),
  })
}

/**
 * Whether any person on the instance has ever had a rebuild recorded at all. The route defaults a
 * person with no row in rebuildState to the same quarantined: false, droppedPages: 0 a person who
 * rebuilt cleanly gets, so "everyone is fine" and "nobody has run yet" are indistinguishable from
 * quarantined/droppedPages alone -- lastSuccessAtMs and lastErrorAtMs are both still null only for
 * the former, since a completed attempt of either kind sets one of them.
 */
function nobodyHasEverRun(people: RebuildPersonState[]): boolean {
  return people.every((person) => person.lastSuccessAtMs === null && person.lastErrorAtMs === null)
}

/**
 * One `RebuildNotice` per person the household's rebuild state actually has something to say
 * about, modelled on Maintenance.tsx: a query for the figures, and the server's own admin gate as
 * the only access control this file has to honour.
 *
 * `allWell` and `neverRun` are two different kinds of nothing to report, and collapsing them would
 * cost an operator the one signal that tells them the feature is wired up at all: "everyone's
 * history rebuilt cleanly" is a fact about every attempt this instance has made, and would be a lie
 * on an instance that has never rebuilt anyone.
 */
export function RebuildHealth() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const status = useRebuildHealth()

  if (status.isPending) return <Loading />
  if (status.isError) {
    return (
      <ErrorState onRetry={() => {
        void queryClient.refetchQueries({ queryKey: queryKeys.rebuildHealth(), exact: true })
      }} error={status.error} />
    )
  }

  const { people, rebuildInFlight } = status.data
  // awaitingRebuild counts as affected, and it is the reason this filter had to change. A person
  // whose version stamp went stale with no attempt behind it - which changing a timezone in
  // Profile does - carries a clean success row, so on the two flags this used to read they were
  // indistinguishable from somebody fine, and the card printed "every person's history rebuilt
  // cleanly" about a member sync had already stopped. allWell has to mean what it says.
  const affected = people.filter(
    (person) => person.quarantined || person.awaitingRebuild || person.droppedPages > 0,
  )

  if (affected.length === 0) {
    return (
      <p className="maintenance-backups">
        {t(nobodyHasEverRun(people) ? 'settings.rebuild.neverRun' : 'settings.rebuild.allWell')}
      </p>
    )
  }

  // One envelope-level flag handed to every notice below, since one worker rebuilds the whole
  // household at once. It matters most on this card of all of them: an operator reads it right
  // after an upgrade, which is precisely when the boot rebuild is in flight and everybody it has
  // not reached yet is listed here - and they are the one person who can restart the container,
  // so "a restart is what runs it" is the sentence that must not appear while the rebuild
  // already is running.
  return (
    <>
      {affected.map((person) => (
        <RebuildNotice
          key={person.personId}
          voice="admin"
          personName={person.displayName}
          quarantined={person.quarantined}
          awaitingRebuild={person.awaitingRebuild}
          rebuildInFlight={rebuildInFlight}
          droppedPages={person.droppedPages}
          lastError={person.lastError}
          drops={person.drops}
        />
      ))}
    </>
  )
}
