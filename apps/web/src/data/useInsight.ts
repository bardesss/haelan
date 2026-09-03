import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { apiGet } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'
import { sourceParam } from '../controls/source.js'

/**
 * Mirrors packages/core/src/query/insights.ts's Insight, not imported from there for the reason
 * useAnnotations.ts gives for mirroring its own wire types rather than importing them: the real
 * type is declared in packages/core's main barrel, which also exports openDatabase and
 * loadOrCreateKey, so importing it would pull Node only code into a browser bundle.
 *
 * current, previous and delta are the response's own values, not that module's: the route in
 * apps/server/src/routes/v1/series.ts rounds current and previous to the metric's catalogue
 * precision and computes delta from those two already rounded ends, not from comparePeriods's raw
 * arithmetic, so a reader's own subtraction of the two numbers shown agrees with the delta printed
 * beside them, provided the numbers are shown in the metric's own stored unit. A page that
 * converts to a different display unit (weight's grams to kilograms, Weight.tsx) breaks that
 * guarantee by dividing an already-settled gram delta into kilograms afterwards, and has to
 * rederive delta itself at the display precision instead, through InsightCard's own `formatDelta`
 * prop.
 */
export interface Insight {
  current: number | null
  previous: number | null
  delta: number | null
  currentDays: number
  previousDays: number
  periodDays: number
  currentCoverage: number | null
  previousCoverage: number | null
  currentRange: { from: string, to: string } | null
  previousRange: { from: string, to: string } | null
  suppressed: boolean
  reason: 'thin-days' | 'thin-coverage' | null
}

export interface InsightRange {
  from: string
  to: string
}

/**
 * Exported so the request shape, including the all sources sentinel's omission, can be asserted
 * without mounting a component. Mirrors baselinePath in useBaseline.ts for the same reason.
 */
export function insightPath(
  personId: string, metric: string, agg: string, from: string, to: string, source: string,
): string {
  const params = new URLSearchParams({ metric, agg, from, to })
  const resolvedSource = sourceParam(source)
  if (resolvedSource !== undefined) params.set('source', resolvedSource)
  return `/api/v1/p/${personId}/insights?${params.toString()}`
}

/**
 * personId comes from the session, never a parameter, for the same reason useSeries does not take
 * one: an account owns exactly one person.
 */
export function useInsight(
  metric: string, agg: string, range: InsightRange, source: string,
): UseQueryResult<Insight> {
  const session = useSession()
  const personId = session.data?.personId
  return useQuery({
    queryKey: queryKeys.resource(personId ?? '', 'insights', { metric, agg, from: range.from, to: range.to, source }),
    enabled: personId !== undefined,
    queryFn: () => apiGet<Insight>(insightPath(personId!, metric, agg, range.from, range.to, source)),
  })
}
