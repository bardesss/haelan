import { RECOVERY_METRIC_SOURCES } from '../api/recoveryIndex.ts'
import { hrvDeviationRun, hrvDeviationSeries, hrvDeviationWindowStart } from './hrvDeviation.ts'
import type { HrvDeviationDay, HrvDeviationRun, HrvReading } from './hrvDeviation.ts'
import type { PersonQuery, SeriesResult } from './personQuery.ts'

/**
 * HRV deviation for every date in `range`, and the run as of `range.to`, from one read.
 *
 * The HRV series is the recovery index's own (`RECOVERY_METRIC_SOURCES`), so a filled day here is
 * a filled day there. Fetched from `hrvDeviationWindowStart(range.from)`: every date in the range
 * needs its week and baseline behind it, and the run at `range.to` needs a full lookback behind
 * that. No `points` argument: thinning is a display concern and would move the statistic.
 */
export function readHrvDeviation(q: PersonQuery, range: { from: string, to: string }): {
  days: HrvDeviationDay[]
  run: HrvDeviationRun | null
  series: SeriesResult
} {
  const source = RECOVERY_METRIC_SOURCES.find((s) => s.key === 'hrv')!
  const series = q.series({ metric: source.metric, agg: source.agg, from: hrvDeviationWindowStart(range.from), to: range.to })
  const readings: HrvReading[] = series.points.map((p) => ({ localDate: p.localDate, value: p.value, filled: p.filled === true }))
  return { days: hrvDeviationSeries(readings, range), run: hrvDeviationRun(readings, range.to), series }
}
