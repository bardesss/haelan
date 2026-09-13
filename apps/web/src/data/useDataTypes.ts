import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { requirePersonId } from './useAnnotations.js'

// Mirrors the shape GET /api/v1/p/:personId/data-types sends (apps/server/src/routes/v1/dataTypes.ts):
// every catalogue type the sync engine can fetch at all, not only the ones it fetches through a
// `list` call -- `floors` and `total-calories` are in here too, fetched by rollup. `excluded` is
// the store's own vocabulary (ExcludedDataTypeStore keeps exclusions, not inclusions), carried
// through unchanged so the one place that flips it to "is this being synced" stays DataTypePicker.
export interface DataTypeChoice {
  id: string
  tier: 'daily' | 'intraday'
  excluded: boolean
}

interface DataTypesResponse { items: DataTypeChoice[] }

/** Shared by the query and the mutation's invalidation below, so both agree on what changed. */
export function dataTypesKey(personId: string): readonly unknown[] {
  return queryKeys.resource(personId, 'data-types')
}

export interface DataTypes {
  items: DataTypeChoice[]
  isPending: boolean
  isError: boolean
  // Read only by ErrorState's own not_found branch (see its comment) - DataTypes.tsx has to reach
  // through this narrowed shape to hand ErrorState the underlying query's error, the same reason
  // useSourceNames.ts's SourceNames carries one too.
  error: unknown
}

export function useDataTypes(): DataTypes {
  const session = useSession()
  const personId = session.data?.personId
  const query = useQuery({
    queryKey: dataTypesKey(personId ?? ''),
    // Same race useSourceNames and useSeries guard: asking before the session resolves would cache
    // an answer under a key naming no person.
    enabled: personId !== undefined,
    queryFn: () => apiGet<DataTypesResponse>(`/api/v1/p/${personId!}/data-types`),
  })

  return {
    items: query.data?.items ?? [],
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
  }
}

export function useSetDataTypes(): UseMutationResult<{ excluded: string[] }, ApiError, { excluded: string[] }> {
  const session = useSession()
  const personId = session.data?.personId
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => {
      const id = requirePersonId(personId)
      return apiSend<{ excluded: string[] }>('PUT', `/api/v1/p/${id}/data-types`, input)
    },
    onSuccess: () => {
      if (personId !== undefined) void queryClient.invalidateQueries({ queryKey: dataTypesKey(personId) })
    },
  })
}
