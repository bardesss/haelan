import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'

// Mirrors BodyAgeRead (packages/core/src/query/bodyAgeRead.ts, over BodyAgeHistory in
// packages/core/src/api/bodyAge.ts), which the route sends whole at the wire's precision
// (apps/server/src/routes/v1/bodyAge.ts): ages, years and gaps to a tenth, the pace to a hundredth,
// each factor's value to its unit's own. Local types for the reason useAllTime.ts gives: apps/web
// imports only @haelan/core's browser-safe subpaths, never its root.

/** The five factors the read carries. HRV is not one: it was dropped as uncitable. */
export type BodyAgeFactorKey = 'vo2Max' | 'restingHeartRate' | 'activity' | 'sleepRegularity' | 'strength'

export type BodyAgeMissing = 'birthDate' | 'sex' | 'vo2Max'

export interface BodyAgeFactor {
  key: BodyAgeFactorKey
  value: number | null
  /** The typical value for the person's age and sex; a value at it counts zero years. */
  reference: number | null
  years: number
  /** Whether the factor's own cap bound its years. */
  capped: boolean
  /** Days with a reading in the window. */
  days: number
  missing: 'tooFewDays' | 'noReading' | null
}

export interface BodyAgeUnavailable {
  enough: false
  endDate: string
  missing: BodyAgeMissing[]
}

export interface BodyAgeAvailable {
  enough: true
  endDate: string
  window: { from: string, to: string }
  calendarAge: number
  bodyAge: number
  /** Body age minus calendar age: negative is younger. */
  gap: number
  totalCapped: boolean
  factors: BodyAgeFactor[]
  /** The factor with most of the gap in its direction, named only when it carries at least half. */
  carriedBy: BodyAgeFactorKey | null
  /** The factor whose reaching its typical level would move the figure most, and by how much. */
  mostRoom: { key: BodyAgeFactorKey, years: number } | null
  fitnessAge: number | null
  vo2MaxDate: string | null
}

export type BodyAge = BodyAgeUnavailable | BodyAgeAvailable

export interface BodyAgeMonth {
  /** `YYYY-MM`. */
  month: string
  endDate: string
  bodyAge: number
  calendarAge: number
  gap: number
}

export interface BodyAgeMethod {
  windowDays: number
  vo2LookbackDays: number
  minFactorDays: number
  gompertzSlope: number
  totalCap: number
  factors: { key: BodyAgeFactorKey, unit: string, cap: number, citation: string }[]
}

export interface BodyAgeRead {
  /** At the last scored day, not today; null with no scored day at all. */
  current: BodyAge | null
  /** The window ending 30 days before `current`'s, when both are available. */
  previous: BodyAgeAvailable | null
  /** One per month with a body age, oldest first. */
  months: BodyAgeMonth[]
  /** Years of body age per calendar year over the last twelve months. */
  pace: number | null
  /** The month with the largest gap below calendar age. */
  youngest: BodyAgeMonth | null
  method: BodyAgeMethod
}

export function bodyAgeKey(personId: string): readonly unknown[] {
  return queryKeys.resource(personId, 'body-age')
}

/**
 * The body age page's one read. No range argument, like all-time: the figure is read at the
 * person's last scored day over a fixed window, so there is nothing for a control to pick.
 */
export function useBodyAge() {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: bodyAgeKey(personId ?? ''),
    // Not before the session resolves: the answer would be cached under a key naming no person.
    enabled: personId !== undefined,
    queryFn: () => apiGet<BodyAgeRead>(`/api/v1/p/${personId!}/body-age`),
  })
}
