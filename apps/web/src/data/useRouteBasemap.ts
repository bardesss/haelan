import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { useSession } from '../auth/session.js'

/**
 * What GET and PUT /api/settings/route-basemap both answer. Mirrors useUpdateCheck.ts's own
 * UpdateStatus, one field only: this switch has nothing to report back, unlike the update check's
 * cached release tag, because it never asks anybody anything on its own - it only says whether
 * WorkoutRoute.tsx is allowed to.
 */
export interface RouteBasemapStatus {
  /** Whether a workout's route card may fetch map tiles from a third party to draw a basemap
   *  under the trace. False is the default for every instance. */
  enabled: boolean
}

/** One cache entry for the whole instance, like updateStatusKey: this is not scoped to a reader. */
export function routeBasemapStatusKey(): readonly unknown[] {
  return ['route-basemap-status']
}

/**
 * How fresh the answer has to be, overriding the query client's own defaults.
 *
 * Everything else in this app caches for a minute because derived data changes when a sync drains,
 * not while somebody reads it. This is not derived data: it is the switch that decides whether a
 * household's coordinates are sent to a third-party tile server, and a stale yes is a request that
 * should not have been made. An admin turning the basemap off does not close anybody else's open
 * tab, and under the shared default that tab would go on drawing tiles for up to a minute, for
 * every route opened in it.
 *
 * Off is cheap to get wrong in the safe direction and expensive in the other, so this asks every
 * time rather than trusting a cached yes.
 */
export const ROUTE_BASEMAP_FRESHNESS = {
  staleTime: 0,
  refetchOnMount: 'always',
} as const

/**
 * Whether this instance may draw a basemap under a route. Read by WorkoutRoute.tsx for every
 * member who opens a workout page, not just an admin - the same split useUpdateStatus takes.
 */
export function useRouteBasemapStatus(): UseQueryResult<RouteBasemapStatus, ApiError> {
  const session = useSession()
  return useQuery({
    queryKey: routeBasemapStatusKey(),
    enabled: session.data !== undefined,
    queryFn: () => apiGet<RouteBasemapStatus>('/api/settings/route-basemap'),
    ...ROUTE_BASEMAP_FRESHNESS,
  })
}

/**
 * Turns the basemap on or off. Admin only: the route answers 'forbidden' to anyone else, which is
 * why About.tsx renders the switch only for an admin - useSetUpdateCheck's own precedent.
 */
export function useSetRouteBasemap(): UseMutationResult<RouteBasemapStatus, ApiError, { enabled: boolean }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => apiSend<RouteBasemapStatus>('PUT', '/api/settings/route-basemap', input),
    onSuccess: (status) => {
      queryClient.setQueryData(routeBasemapStatusKey(), status)
    },
  })
}
