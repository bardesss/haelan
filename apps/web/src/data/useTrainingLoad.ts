import { useMemo } from 'react'
import { CARDIO_LOAD_METRIC } from '@haelan/core/cardio-load'
import { chronicWindowStart, trainingLoad } from '@haelan/core/training-load'
import type { TrainingLoad } from '@haelan/core/training-load'
import { useSeries } from './useSeries.js'
import type { UseQueryResult } from '@tanstack/react-query'
import type { MetricSeries } from './useSeries.js'

/**
 * The person's acute and chronic cardio load as of `on`.
 *
 * **This reader feeds a printed number, so it states what it honours** (CONTRIBUTING.md, "A reader
 * that feeds a number says what it honours"):
 *
 * - **Session kinds: none.** It reads merged daily rows, not sessions, so the sleep against
 *   exercise confusion that once answered 65.10 TRIMP for a night cannot arise here.
 * - **Override actions: both, already applied upstream.** Sample exclusions and corrections were
 *   resolved when the zone minute rows were derived, and `derive/cardioLoad.ts` computes from those
 *   derived rows rather than reaching back to samples for a second answer.
 * - **Thinned: no.** `seriesPath` sets no `points` parameter, so `/series` takes its unthinned
 *   branch and hands back the stored rows. That is load bearing rather than incidental: a point
 *   budget is an argument about display, and a load that moved when a chart's budget moved would
 *   not be measuring anything. Anything added here that starts passing `points` breaks the number.
 *
 * The window is fixed by the metric's own definition and NOT by the page's range control. ACWR is
 * 7 days against 28; a card that stretched those to whatever range the reader had selected would
 * be showing a different statistic under the same name. `chronicWindowStart` comes from the module
 * that does the arithmetic, so the span fetched and the span read are the same span by
 * construction.
 */
export function useTrainingLoad(on: string, source: string): {
  query: UseQueryResult<Record<string, MetricSeries>>
  load: TrainingLoad | undefined
} {
  const range = useMemo(
    () => ({ from: chronicWindowStart(on), to: on, source }),
    [on, source],
  )
  const query = useSeries([CARDIO_LOAD_METRIC], range, 'sum')
  const load = useMemo(() => {
    const points = query.data?.[CARDIO_LOAD_METRIC]?.points
    if (points === undefined) return undefined
    // A day nobody wore a watch is absent from /series rather than sent as a null, which is the
    // wear signal trainingLoad counts. Mapping to a dense calendar here would destroy it.
    return trainingLoad(points.map((point) => ({ localDate: point.localDate, load: point.value })), on)
  }, [query.data, on])
  return { query, load }
}
