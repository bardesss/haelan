import { useMemo } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { recoveryIndexSeries, recoveryWindowStart } from '@haelan/core/recovery-index'
import type { RecoveryIndex, RecoveryIndexAvailable, DayValue } from '@haelan/core/recovery-index'
import { useSeries } from './useSeries.js'
import type { MetricSeries, SeriesPoint } from './useSeries.js'

const LAST_METRICS = ['daily_hrv', 'resting_heart_rate', 'respiratory_rate', 'sleep_bedtime_minutes']
const SUM_METRICS = ['sleep_asleep_minutes']

/**
 * The span that must be fetched in order to score every day in `range`.
 *
 * `recoveryWindowStart` is applied to `range.from`, not `range.to`. The core module's own doc
 * comment on `recoveryIndexSeries` describes a single day's fetch window ("filtered to merged
 * daily rows over `recoveryWindowStart(on)` through `on`"), which reads as though the window
 * belongs at the end of a range - it does not, for a caller scoring more than one day. Every date
 * between `range.from` and `range.to` gets its own score, and each of those needs its OWN full
 * baseline-plus-sleep-week window behind it. The earliest fetched day is therefore the window
 * start of the EARLIEST scored day, not the latest one.
 */
export function recoveryFetchRange(range: { from: string, to: string }): { from: string, to: string } {
  return { from: recoveryWindowStart(range.from), to: range.to }
}

const toDayValues = (series: MetricSeries | undefined): DayValue[] =>
  (series?.points ?? []).map((point: SeriesPoint) => ({ localDate: point.localDate, value: point.value }))

/**
 * Which of the two /series requests `useRecoveryIndex` should surface as `query`.
 *
 * The hook fires two requests because the five metrics do not share an agg: four are `last` and
 * `sleep_asleep_minutes` is `sum`. Returning `lastQuery` unconditionally would make a `sumQuery`
 * failure invisible - if the sum request errors after the last request has already settled,
 * `lastQuery` reports neither `isError` nor `isPending`, `byDate` stays `undefined` because
 * `sumQuery.data` is missing, and the card renders "not enough recent data": a data-shortage
 * message for what was actually a failed request. Error is checked before pending so that whichever
 * query is broken wins over one that is merely still loading, and a caller's retry then refetches
 * the query that actually failed rather than the one that happened to still be in flight.
 */
export function selectRecoveryQuery<T>(
  lastQuery: UseQueryResult<T>,
  sumQuery: UseQueryResult<T>,
): UseQueryResult<T> {
  if (lastQuery.isError) return lastQuery
  if (sumQuery.isError) return sumQuery
  if (lastQuery.isPending) return lastQuery
  if (sumQuery.isPending) return sumQuery
  return lastQuery
}

/**
 * The person's recovery index across `range`.
 *
 * **This reader feeds a printed number, so it states what it honours** (CONTRIBUTING.md):
 *
 * - **Session kinds: none.** It reads merged daily rows, never sessions.
 * - **Override actions: both, already applied upstream** at derivation.
 * - **Thinned: no.** `seriesPath` sets no `points` parameter, so `/series` takes its unthinned
 *   branch. That is load bearing: an index that moved when a chart's point budget moved would not
 *   be measuring anything. Anything here that starts passing `points` breaks the number.
 *
 * Two requests rather than one, because the five metrics do not share an agg: four are `last` and
 * `sleep_asleep_minutes` is `sum`. That is the same REQUESTS-by-agg split Dashboard and Recovery
 * already use. `query` is not simply `lastQuery` - see `selectRecoveryQuery` for why a failure or
 * pending state of `sumQuery` has to be represented too.
 */
export function useRecoveryIndex(range: { from: string, to: string }, source: string): {
  query: UseQueryResult<Record<string, MetricSeries>>
  byDate: Map<string, RecoveryIndex> | undefined
  latest: { date: string, index: RecoveryIndexAvailable } | undefined
} {
  const fetchRange = useMemo(() => ({ ...recoveryFetchRange(range), source }), [range.from, range.to, source])
  const lastQuery = useSeries(LAST_METRICS, fetchRange, 'last')
  const sumQuery = useSeries(SUM_METRICS, fetchRange, 'sum')
  const query = selectRecoveryQuery(lastQuery, sumQuery)

  const byDate = useMemo(() => {
    if (lastQuery.data === undefined || sumQuery.data === undefined) return undefined
    return recoveryIndexSeries({
      hrv: toDayValues(lastQuery.data.daily_hrv),
      restingHeartRate: toDayValues(lastQuery.data.resting_heart_rate),
      respiratoryRate: toDayValues(lastQuery.data.respiratory_rate),
      bedtimeMinutes: toDayValues(lastQuery.data.sleep_bedtime_minutes),
      asleepMinutes: toDayValues(sumQuery.data.sleep_asleep_minutes),
    }, range)
  }, [lastQuery.data, sumQuery.data, range.from, range.to])

  const latest = useMemo(() => {
    if (byDate === undefined) return undefined
    // The most recent day that could be scored, which is routinely a few days behind today: this
    // archive lags sync by several days as a matter of course, and a prominent number from last
    // Sunday with nothing saying so is worse than a quiet one. The tile renders this date.
    const scored = [...byDate.entries()]
      .filter((entry): entry is [string, RecoveryIndexAvailable] => entry[1].enough)
      .sort((a, b) => a[0] < b[0] ? 1 : -1)
    const first = scored[0]
    return first === undefined ? undefined : { date: first[0], index: first[1] }
  }, [byDate])

  return { query, byDate, latest }
}
