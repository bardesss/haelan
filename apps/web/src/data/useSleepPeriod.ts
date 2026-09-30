import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import type { PeriodRange, SleepPeriodData } from './periodTypes.js'

/** `queryKeys.resource(personId, 'sleep-period')` as the prefix, then the range, anchor and source. */
export function sleepPeriodKey(personId: string, range: string, anchor: string, source: string): readonly unknown[] {
  return [...queryKeys.resource(personId, 'sleep-period'), range, anchor, source]
}

/**
 * The Sleep overview's read (GET /sleep/period). The Day tab has no period, so `day` fetches
 * nothing. Source 'all' is the merge and is sent as no parameter; the page resolves an unknown
 * source to 'all' before it gets here, since the server answers one with a 400.
 */
export function useSleepPeriod(
  input: { range: PeriodRange | 'day', anchor: string, source: string },
): UseQueryResult<SleepPeriodData> {
  const session = useSession()
  const personId = session.data?.personId
  const { range, anchor, source } = input
  return useQuery({
    queryKey: sleepPeriodKey(personId ?? '', range, anchor, source),
    enabled: personId !== undefined && range !== 'day',
    queryFn: () => {
      const params = new URLSearchParams({ range, anchor })
      if (source !== 'all') params.set('source', source)
      return apiGet<SleepPeriodData>(`/api/v1/p/${personId!}/sleep/period?${params.toString()}`)
    },
  })
}
