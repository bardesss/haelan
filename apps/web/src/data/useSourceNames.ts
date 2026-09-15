import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { requirePersonId } from './useAnnotations.js'

// Mirrors NamedSource in packages/core/src/store/sourceAliases.ts, which the route sends whole,
// the same choice useSyncStatus.ts makes for its own response type and for the same reason: the
// web app imports only @haelan/core's browser safe subpaths (./metrics, ./target-key), never its
// root export, because the root pulls better-sqlite3 and drizzle into the browser bundle.
export interface NamedSource {
  id: string
  externalId: string
  displayName: string
  alias: string | null
  name: string
  kind: 'device' | 'app' | 'manual'
  createdAtMs: number
}

/**
 * What the listing adds when it is asked for `?activity=1`, which only the settings card does.
 *
 * A separate type rather than optional fields on NamedSource: every other caller of this route
 * wants names and nothing else, and computing these measured 19-60ms against a real archive on a
 * route ControlRow hits from every page. Optional fields would put that cost back on the hot path
 * the moment somebody read them.
 */
export interface SourceActivityFields {
  /** Local date, null when this source has never produced a row. */
  lastReportedDate: string | null
  reportingDates: number
  medianGapDays: number | null
  /** 'unjudged' means too little history to have a cadence, not that it is fine. */
  status: 'reporting' | 'stale' | 'unjudged'
  /**
   * Whether the card lists it among the live sources. Computed by the server, not here: the
   * thresholds behind it belong in one place, and a second copy in the browser is how a rule
   * drifts. See packages/core/src/query/sourceActivity.ts.
   */
  reportingNow: boolean
}

export type NamedSourceWithActivity = NamedSource & SourceActivityFields

interface SourcesResponse { items: NamedSource[] }

/** Shared by the query, both mutations' invalidation and the tests, so all four agree. */
export function sourceNamesKey(personId: string): readonly unknown[] {
  return queryKeys.resource(personId, 'sources')
}

export interface SourceNames {
  /**
   * The label for a source id, or the id itself when nothing better is known.
   *
   * The fallback is what makes this safe to call from anywhere: before the query answers, and
   * after it fails, every picker reads exactly as it did before this milestone rather than going
   * blank. Nothing on any page waits on names.
   */
  nameOf: (sourceId: string) => string
  sources: NamedSource[]
  isPending: boolean
  isError: boolean
  // Read only by ErrorState's own not_found branch (see its comment) - SourceNames.tsx has to
  // reach through this narrowed shape to hand ErrorState the underlying query's error.
  error: unknown
}

/**
 * The same listing with each source's activity, for the one surface that shows it.
 *
 * Its own key, a child of the plain one, so both are cached separately and a rename still
 * refreshes both: invalidateQueries matches by prefix unless told otherwise, and the two
 * mutations below pass the parent key.
 */
export function sourceActivityKey(personId: string): readonly unknown[] {
  return [...sourceNamesKey(personId), 'activity']
}

export function useSourceNames(): SourceNames {
  const session = useSession()
  const personId = session.data?.personId
  const query = useQuery({
    queryKey: sourceNamesKey(personId ?? ''),
    // Same race useSyncStatus and useSeries guard: asking before the session resolves would cache
    // an answer under a key naming no person.
    enabled: personId !== undefined,
    queryFn: () => apiGet<SourcesResponse>(`/api/v1/p/${personId!}/sources`),
  })

  const items = query.data?.items
  // Memoised on the query's own data reference, not rebuilt as a fresh object literal every
  // render: `nameOf` sits in IntradayHeartRate's `build` useCallback deps, which useChart keys its
  // init/dispose effect on, so a fresh function here (even one that reads the same names) disposed
  // and reinitialised that chart on every render regardless of whether anything it draws had
  // changed -- the exact defect chart-lifecycle.test.tsx exists to catch, on a chart that test
  // didn't reach until it grew a Day tab case.
  return useMemo(() => {
    const sources = items ?? []
    const byId = new Map(sources.map((s) => [s.id, s.name]))
    return {
      nameOf: (sourceId: string) => byId.get(sourceId) ?? sourceId,
      sources,
      isPending: query.isPending,
      isError: query.isError,
      error: query.error,
    }
  }, [items, query.isPending, query.isError, query.error])
}

/**
 * The listing with each source's activity, for the settings card and nothing else.
 *
 * A second hook rather than a flag on useSourceNames, because the two answer different questions
 * at different prices. useSourceNames backs ControlRow and IntradayHeartRate, so it runs on every
 * page, and the activity fields measured 19-60ms against a real archive - growing with the daily
 * row count. Keeping them behind their own hook and their own query key means no page pays for a
 * number only one card shows.
 */
export function useSourcesWithActivity(): {
  sources: NamedSourceWithActivity[]
  isPending: boolean
  isError: boolean
  error: unknown
} {
  const session = useSession()
  const personId = session.data?.personId
  const query = useQuery({
    queryKey: sourceActivityKey(personId ?? ''),
    enabled: personId !== undefined,
    queryFn: () => apiGet<{ items: NamedSourceWithActivity[] }>(
      `/api/v1/p/${personId!}/sources?activity=1`,
    ),
  })
  return {
    sources: query.data?.items ?? [],
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
  }
}

export function useRenameSource(): UseMutationResult<{ name: string }, ApiError, { sourceId: string, alias: string }> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => {
      const id = requirePersonId(personId)
      return apiSend<{ name: string }>(
        'PUT', `/api/v1/p/${id}/sources/${input.sourceId}/alias`, { alias: input.alias },
      )
    },
    onSuccess: () => {
      if (personId !== undefined) void queryClient.invalidateQueries({ queryKey: sourceNamesKey(personId) })
    },
  })
}

export function useClearSourceName(): UseMutationResult<{ name: string }, ApiError, { sourceId: string }> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => {
      const id = requirePersonId(personId)
      return apiSend<{ name: string }>(
        'DELETE', `/api/v1/p/${id}/sources/${input.sourceId}/alias`,
      )
    },
    onSuccess: () => {
      if (personId !== undefined) void queryClient.invalidateQueries({ queryKey: sourceNamesKey(personId) })
    },
  })
}
