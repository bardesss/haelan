import type { DailyRow, SampleLike } from './rollup.ts'
import { DERIVATION_VERSION } from './version.ts'

/**
 * Which clock minutes are counted by both activity-minute families.
 *
 * probe/findings/activity-minute-overlap.md measured that they overlap heavily - every peak minute
 * in the sampled window was also a vigorous minute - so a chart stacking the two double counts.
 * This derives the one fact that was missing: the size of the intersection, per activity level.
 * The four bands the chart draws are then arithmetic on rows that already exist.
 *
 * Only the intersection is stored. Deriving four finished bands would duplicate active_minutes_*
 * for the three levels on every day with no peak minute, and two rows asserting the same fact is
 * two answers to what a day means.
 */

export const PEAK_METRIC = 'active_zone_minutes_peak'

/** Level metric to the metric counting its minutes that were also peak. */
export const OVERLAP_BY_LEVEL: Readonly<Record<string, string>> = {
  active_minutes_light: 'active_minutes_light_peak',
  active_minutes_moderate: 'active_minutes_moderate_peak',
  active_minutes_vigorous: 'active_minutes_vigorous_peak',
}

/** Every metric this derivation reads. The merged view resolves a winning source across all four. */
export const BAND_FAMILY: readonly string[] = [...Object.keys(OVERLAP_BY_LEVEL), PEAK_METRIC]

/**
 * Counts, per level, the distinct clock minutes carrying both that level and a peak zone minute.
 *
 * Distinct minutes rather than rows, for two independent reasons. A peak sample's `value` is 2 in
 * the peak and cardio zones - it is Fitbit's Active Zone Minutes score, not a duration - so
 * summing it reports twice the clock time. And `samples` is keyed including the sample agg, so one
 * minute can legitimately arrive as more than one row; counting rows would inflate the overlap the
 * first time anything downsampled these metrics.
 */
export function overlapMinutes(rows: readonly SampleLike[]): Map<string, number> {
  const peakMinutes = new Set<number>()
  for (const row of rows) {
    if (row.metric === PEAK_METRIC && row.value !== null) peakMinutes.add(row.utcMs)
  }

  // level metric -> the distinct minutes at that level which were also peak
  const byLevel = new Map<string, Set<number>>()
  for (const row of rows) {
    const overlapMetric = OVERLAP_BY_LEVEL[row.metric]
    if (overlapMetric === undefined || row.value === null) continue
    if (!peakMinutes.has(row.utcMs)) continue
    let minutes = byLevel.get(overlapMetric)
    if (!minutes) { minutes = new Set(); byLevel.set(overlapMetric, minutes) }
    minutes.add(row.utcMs)
  }

  const out = new Map<string, number>()
  for (const [metric, minutes] of byLevel) out.set(metric, minutes.size)
  return out
}

export function deriveActivityBandsDay(input: {
  personId: string
  localDate: string
  source: string
  rows: readonly SampleLike[]
}): DailyRow[] {
  const counts = overlapMinutes(input.rows)
  // Object.keys order, so the rows come back light, moderate, vigorous however the samples arrived,
  // which is what keeps a rebuild's row order stable.
  return Object.values(OVERLAP_BY_LEVEL)
    .filter((metric) => counts.has(metric))
    .map((metric) => ({
      personId: input.personId,
      localDate: input.localDate,
      metric,
      agg: 'sum' as const,
      source: input.source,
      value: counts.get(metric)!,
      // A count of minutes has no samples of its own underneath it, so the fraction of the day's
      // hours carrying one is not a question this row can answer - the same reason
      // derive/sleep.ts and derive/exercise.ts both leave it null.
      coverage: null,
      // Only ever set on a merged row, and set by mergeActivityBandsDay rather than here.
      sourceMix: null,
      derivationVersion: DERIVATION_VERSION,
    }))
}
