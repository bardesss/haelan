import { edwardsLoad } from '../api/cardioLoad.ts'
import type { DailyRow } from './rollup.ts'
import { DERIVATION_VERSION } from './version.ts'

/**
 * The day's cardio load, from the day's zone minutes.
 *
 * Derived from derived rows rather than from samples a second time. By the time this runs, the
 * zone-minute rows have already had sample exclusions applied and, for the merged view, already
 * had the priority list resolved; recomputing from samples here would be a second answer to what a
 * day's zone minutes are, and the two would disagree the first time either changed.
 *
 * Edwards only. Banister needs a floor this cannot read - see api/cardioLoad.ts's own comment on
 * banisterLoad - so no daily row will ever carry it.
 */

const ZONE_METRICS = {
  lightMinutes: 'time_in_heart_rate_zone_light_minutes',
  moderateMinutes: 'time_in_heart_rate_zone_moderate_minutes',
  vigorousMinutes: 'time_in_heart_rate_zone_vigorous_minutes',
  peakMinutes: 'time_in_heart_rate_zone_peak_minutes',
} as const

export const CARDIO_LOAD_METRIC = 'cardio_load_edwards'

export function deriveCardioLoadDay(input: {
  personId: string
  localDate: string
  rows: readonly DailyRow[]
}): DailyRow[] {
  const zoneNames = new Set<string>(Object.values(ZONE_METRICS))
  // Insertion ordered, so the rows come back in the order the sources first appeared, which is
  // what the per-source and merged tests pin and what keeps a rebuild's row order stable.
  const bySource = new Map<string, Map<string, number>>()
  for (const row of input.rows) {
    // 'sum' is the only aggregate these four declare (derive/metrics.ts), and reading any other
    // would take a number computed to answer a different question.
    if (row.agg !== 'sum' || !zoneNames.has(row.metric) || row.value === null) continue
    const forSource = bySource.get(row.source) ?? new Map<string, number>()
    bySource.set(row.source, forSource)
    forSource.set(row.metric, row.value)
  }

  const out: DailyRow[] = []
  for (const [source, values] of bySource) {
    const load = edwardsLoad({
      lightMinutes: values.get(ZONE_METRICS.lightMinutes) ?? null,
      moderateMinutes: values.get(ZONE_METRICS.moderateMinutes) ?? null,
      vigorousMinutes: values.get(ZONE_METRICS.vigorousMinutes) ?? null,
      peakMinutes: values.get(ZONE_METRICS.peakMinutes) ?? null,
    })
    if (load === null) continue
    out.push({
      personId: input.personId,
      localDate: input.localDate,
      metric: CARDIO_LOAD_METRIC,
      agg: 'sum',
      source,
      value: load,
      // A load has no samples of its own underneath it, so the fraction of the day's hours
      // carrying one is not a question this row can answer - the same reason derive/sleep.ts and
      // derive/exercise.ts both leave it null.
      coverage: null,
      // The mix on the zone rows this was computed from already records which source won which
      // hour. Copying it here would claim this row merged something, when what merged was the
      // input; recomputing it would count a different thing than the column counts everywhere
      // else. Null is the honest answer, the same one deriveExerciseDay gives a per source row.
      sourceMix: null,
      derivationVersion: DERIVATION_VERSION,
    })
  }
  return out
}
