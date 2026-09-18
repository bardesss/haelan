import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { requirePersonId } from './useAnnotations.js'

// Mirrors the body priorityBodyFor assembles in apps/server/src/routes/v1/sources.ts. apps/web
// cannot resolve fallback placement itself - priorityFrom and fallbackOrder both live in
// @haelan/core's root export, which pulls better-sqlite3 and drizzle into the browser bundle - so
// the route resolves it and this type is the shape it sends back.
export interface PriorityEntry {
  sourceId: string
  configured: boolean
}

export interface PriorityBody {
  configured: boolean
  order: PriorityEntry[]
}

/** Shared by the query and the mutation's invalidation, so the two agree on what changed. */
export function sourcePriorityKey(personId: string): readonly unknown[] {
  return queryKeys.resource(personId, 'source-priority')
}

const pathFor = (personId: string): string => `/api/v1/p/${personId}/source-priority`

export function useSourcePriority(): UseQueryResult<PriorityBody, ApiError> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: sourcePriorityKey(personId ?? ''),
    enabled: personId !== undefined,
    queryFn: () => apiGet<PriorityBody>(pathFor(personId!)),
  })
}

export function useSetSourcePriority(): UseMutationResult<PriorityBody, ApiError, string[]> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sourceIds: string[]) => {
      const id = requirePersonId(personId)
      return apiSend<PriorityBody>('PUT', pathFor(id), { sourceIds })
    },
    // A ranking change marks contested days dirty and the drainer re-derives them in the
    // background, so every card reading merged rows for this person is stale the moment this
    // resolves, not only the priority list itself. Invalidating the whole person is what
    // queryKeys.person is for; this key alone would leave every chart on the page showing the
    // old merge until something else happened to refetch it.
    onSuccess: () => {
      if (personId !== undefined) void queryClient.invalidateQueries({ queryKey: queryKeys.person(personId) })
    },
  })
}
