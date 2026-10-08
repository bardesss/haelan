import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { addDays } from '../controls/range.js'

// Mirrors the run packages/core/src/query/hrvDeviation.ts hands the route, as of its `to` day. The
// core module has no browser safe subpath, so the shape is copied by value, as useAnnotations.ts does.
export interface HrvRun {
  side: 'below' | 'above'
  /** Measured days in the run; the lookback when `capped`. */
  days: number
  /** The run reached the far end of the lookback and may go on. */
  capped: boolean
  since: string
  sideNights: number
  weekReadings: number
  filledDays: number
}

export interface HrvDeviationBody {
  days: unknown[]
  run: HrvRun | null
}

/**
 * Days back from `on` that the run's answer can depend on: the sixty day lookback, plus the week the
 * rolling figure averages, plus the sixty day baseline behind the earliest of those (the core module's
 * hrvDeviationWindowStart). The query key carries this window so an applied override anywhere inside
 * it invalidates the read (useAnnotations.ts overlapsAffected); the request itself asks for one day.
 */
const HRV_RUN_DEPENDS_ON_DAYS = 60 + 7 + 60

export function hrvDeviationPath(personId: string, on: string): string {
  const params = new URLSearchParams({ from: on, to: on })
  return `/api/v1/p/${personId}/hrv-deviation?${params.toString()}`
}

/** The HRV stretch ending on `on`, or no request at all when there is no such day. */
export function useHrvDeviation(on: string | null): UseQueryResult<HrvDeviationBody> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'hrv-deviation', {
      from: on === null ? '' : addDays(on, -(HRV_RUN_DEPENDS_ON_DAYS - 1)), to: on ?? '',
    }),
    enabled: personId !== undefined && on !== null,
    queryFn: () => apiGet<HrvDeviationBody>(hrvDeviationPath(personId!, on!)),
  })
}
