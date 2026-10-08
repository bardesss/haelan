import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import type { ActivityPeriodData, PeriodRange, RecoveryPeriodData, SleepPeriodData } from './periodTypes.js'

export type PeriodKind = 'sleep' | 'activity' | 'recovery'
export interface PeriodReadInput { range: PeriodRange | 'day', anchor: string, source: string }

/** `queryKeys.resource(personId, '<kind>-period')` as the prefix, then the range, anchor and source. */
export function periodKey(kind: PeriodKind, personId: string, range: string, anchor: string, source: string): readonly unknown[] {
  return [...queryKeys.resource(personId, `${kind}-period`), range, anchor, source]
}

/**
 * An overview's read (GET /sleep/period or /activity/period). The Day tab has no period, so `day`
 * fetches nothing. Source 'all' is the merge and is sent as no parameter; the page resolves an
 * unknown source to 'all' before it gets here, since the server answers one with a 400.
 */
export function usePeriodRead<T>(kind: PeriodKind, input: PeriodReadInput): UseQueryResult<T> {
  const session = useSession()
  const personId = session.data?.personId
  const { range, anchor, source } = input
  return useQuery({
    queryKey: periodKey(kind, personId ?? '', range, anchor, source),
    enabled: personId !== undefined && range !== 'day',
    queryFn: () => {
      const params = new URLSearchParams({ range, anchor })
      if (source !== 'all') params.set('source', source)
      return apiGet<T>(`/api/v1/p/${personId!}/${kind}/period?${params.toString()}`)
    },
  })
}

/** The Sleep overview's read (GET /sleep/period). */
export const useSleepPeriod = (input: PeriodReadInput): UseQueryResult<SleepPeriodData> => usePeriodRead<SleepPeriodData>('sleep', input)

/** The Activity overview's read (GET /activity/period). */
export const useActivityPeriod = (input: PeriodReadInput): UseQueryResult<ActivityPeriodData> => usePeriodRead<ActivityPeriodData>('activity', input)

/** The Recovery overview's read (GET /recovery/period). */
export const useRecoveryPeriod = (input: PeriodReadInput): UseQueryResult<RecoveryPeriodData> => usePeriodRead<RecoveryPeriodData>('recovery', input)
