import { recoveryWindowStart, RECOVERY_METRIC_SOURCES } from '../api/recoveryIndex.ts'
import type { DayValue, RecoveryIndexInput, RecoveryMetricSource } from '../api/recoveryIndex.ts'
import type { PersonQuery, SeriesResult } from './personQuery.ts'

/** How many of a fetched series' days were filled in from the intraday fallback, out of how many. */
export interface FilledCount {
  filled: number
  of: number
}

function filledCountOf(result: SeriesResult): FilledCount {
  return { filled: result.points.filter((point) => point.filled).length, of: result.points.length }
}

/**
 * The five daily series `recoveryIndexSeries` needs, fetched over the window every date in
 * `range` needs behind it.
 *
 * `from` is `recoveryWindowStart(range.from)`, never a window anchored on `range.to`: every date
 * between `range.from` and `range.to` gets scored against its OWN 60-day baseline plus its own
 * 6-day sleep week, and the earliest of those windows belongs to the range's earliest date, not
 * its latest. Getting this wrong scores the earliest requested days against a baseline that is
 * silently too thin, which reads as `missing` rather than as the bug it is - the same reasoning
 * `apps/web/src/data/useRecoveryIndex.ts`'s `recoveryFetchRange` documents for the web reader.
 *
 * No `points` argument, anywhere in this file. A point budget is a display concern for a chart;
 * an index that moved with a chart's own budget would not be measuring anything.
 */
export function readRecoveryInput(q: PersonQuery, range: { from: string, to: string }): {
  input: RecoveryIndexInput
  hrvFilled: FilledCount
} {
  const from = recoveryWindowStart(range.from)
  const toDayValues = (result: SeriesResult): DayValue[] =>
    result.points.map((point) => ({ localDate: point.localDate, value: point.value }))
  // RECOVERY_METRIC_SOURCES (@haelan/core/recovery-index) is the one place that says which
  // /series metric and agg fill each of the five inputs - fetched here by `source.key` rather
  // than re-typing the pairing, so this can never drift from what the web hook and the probe read.
  const fetchSeries = (key: RecoveryMetricSource['key']): SeriesResult => {
    const source = RECOVERY_METRIC_SOURCES.find((s) => s.key === key)
    if (source === undefined) throw new Error(`no recovery metric source declared for '${key}'`)
    return q.series({ metric: source.metric, agg: source.agg, from, to: range.to })
  }

  // hrv is the only one of the five inputs `DailyPoint.filled` can ever be true for -
  // DEVICE_ROLLED_EQUIVALENT (packages/core/src/query/personQuery.ts) maps a fallback only for
  // daily_hrv and daily_spo2, and spo2 is not a recovery input. The other four fetches below never
  // need this, so only hrv's raw SeriesResult is kept around long enough to count it.
  const hrvResult = fetchSeries('hrv')

  return {
    input: {
      hrv: toDayValues(hrvResult),
      restingHeartRate: toDayValues(fetchSeries('restingHeartRate')),
      respiratoryRate: toDayValues(fetchSeries('respiratoryRate')),
      asleepMinutes: toDayValues(fetchSeries('asleepMinutes')),
      bedtimeMinutes: toDayValues(fetchSeries('bedtimeMinutes')),
    },
    hrvFilled: filledCountOf(hrvResult),
  }
}
