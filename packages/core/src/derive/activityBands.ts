import type { DailyRow, SampleLike } from './rollup.ts'
import { MERGED_SOURCE } from './rollup.ts'
import { DERIVATION_VERSION } from './version.ts'
import { encodeMix } from './merge.ts'
import { localHourOf } from './localDay.ts'
import type { Priority } from './priority.ts'

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

/**
 * The merged view of the day's bands.
 *
 * Resolves a winning source per local hour for the family as a whole, then runs the same
 * intersection over that hour's rows from that source alone. mergeDay's per metric resolution
 * cannot be reused here: it can hand one hour's activity levels to one device and that hour's peak
 * minutes to another, and intersecting across that invents a minute neither device described. This
 * is mergeSleepDay's shape, for mergeSleepDay's reason - a band is one fact and must come from one
 * recorder.
 *
 * An hour whose winner recorded levels but no zone data therefore contributes no peak minutes,
 * rather than borrowing a loser's. That is the same trade mergeDay already makes: a lower priority
 * source fills an hour only when the winner observed nothing in it at all.
 */
export function mergeActivityBandsDay(input: {
  personId: string
  localDate: string
  rows: readonly SampleLike[]
  priority: Priority
}): DailyRow[] {
  const family = new Set(BAND_FAMILY)

  // local hour -> source -> that source's rows in the hour
  const byHour = new Map<number, Map<string, SampleLike[]>>()
  for (const row of input.rows) {
    if (!family.has(row.metric) || row.value === null) continue
    const hour = localHourOf(row.utcMs, row.tzOffsetMinutes)
    let bySource = byHour.get(hour)
    if (!bySource) { bySource = new Map(); byHour.set(hour, bySource) }
    const bucket = bySource.get(row.sourceId)
    if (bucket) bucket.push(row)
    else bySource.set(row.sourceId, [row])
  }

  const winning: SampleLike[] = []
  const hoursWon = new Map<string, number>()
  for (const [, bySource] of byHour) {
    let bestSource: string | null = null
    let bestRank = Number.POSITIVE_INFINITY
    for (const sourceId of bySource.keys()) {
      // The family's best rank across its four metrics, so a list configured on any one of them is
      // respected without one metric's list silently deciding for the other three. Ties break on
      // the source id so a rebuild is deterministic.
      const rank = Math.min(...BAND_FAMILY.map((metric) => input.priority.rank(metric, sourceId)))
      if (rank < bestRank || (rank === bestRank && bestSource !== null && sourceId < bestSource)) {
        bestRank = rank
        bestSource = sourceId
      }
    }
    if (bestSource === null) continue
    winning.push(...bySource.get(bestSource)!)
    hoursWon.set(bestSource, (hoursWon.get(bestSource) ?? 0) + 1)
  }

  const counts = overlapMinutes(winning)
  const mix = encodeMix([...hoursWon].map(([source, hours]) => ({ source, hours })))
  return Object.values(OVERLAP_BY_LEVEL)
    .filter((metric) => counts.has(metric))
    .map((metric) => ({
      personId: input.personId,
      localDate: input.localDate,
      metric,
      agg: 'sum' as const,
      source: MERGED_SOURCE,
      value: counts.get(metric)!,
      coverage: null,
      sourceMix: mix,
      derivationVersion: DERIVATION_VERSION,
    }))
}
