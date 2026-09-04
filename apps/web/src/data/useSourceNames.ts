import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'

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

  const sources = query.data?.items ?? []
  const byId = new Map(sources.map((s) => [s.id, s.name]))
  return {
    nameOf: (sourceId: string) => byId.get(sourceId) ?? sourceId,
    sources,
    isPending: query.isPending,
    isError: query.isError,
  }
}

export function useRenameSource(): UseMutationResult<{ name: string }, ApiError, { sourceId: string, alias: string }> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => apiSend<{ name: string }>(
      'PUT', `/api/v1/p/${personId!}/sources/${input.sourceId}/alias`, { alias: input.alias },
    ),
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
    mutationFn: (input) => apiSend<{ name: string }>(
      'DELETE', `/api/v1/p/${personId!}/sources/${input.sourceId}/alias`,
    ),
    onSuccess: () => {
      if (personId !== undefined) void queryClient.invalidateQueries({ queryKey: sourceNamesKey(personId) })
    },
  })
}
