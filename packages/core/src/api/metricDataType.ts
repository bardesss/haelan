import { DATA_TYPES } from './catalogue.ts'
import { SLEEP_METRICS } from '../derive/metrics.ts'

/**
 * Built once, from the catalogue rather than hand-copied, for the reason coverageSignal.ts's own
 * module-level set gives: a Map built here at load time cannot go stale the way a written-out
 * list would the day a new type is added and nobody remembers to touch a second file. A plain
 * metric contributes its own name; a sub-dimensional type (active-minutes, active-zone-minutes)
 * contributes every value in metricByKey instead, because each per-level metric it produces
 * belongs to the type, not to the placeholder name the type itself declares on `metric`.
 */
const DATA_TYPE_BY_METRIC = new Map<string, string>()
for (const type of DATA_TYPES) {
  if (type.metric !== '') DATA_TYPE_BY_METRIC.set(type.metric, type.id)
  for (const metric of Object.values(type.subDimension?.metricByKey ?? {})) {
    DATA_TYPE_BY_METRIC.set(metric, type.id)
  }
}

/**
 * `sleep` and `exercise` are `target: 'sessions'` catalogue entries: their own `metric` field
 * ('sleep', 'exercise', both handled by the loop above) is a placeholder nothing on a chart ever
 * reads, and the metrics a person actually sees -- sleep_asleep_minutes and its ten siblings,
 * workout_count, workout_minutes -- are produced by derive/sleep.ts and derive/exercise.ts from
 * the sessions these two types fetch, not by the catalogue at all. Neither the catalogue nor
 * derive/metrics.ts's MetricSpec records which data type produced a derived metric (metrics.ts's
 * own comment on MetricSpec.unit: sub-dimension and sleep metrics "have no data type of their own
 * to inherit one from"), so this association cannot be derived the way every entry above it is,
 * and turning sleep or exercise off used to leave every one of these metrics with no data type to
 * be excluded through at all -- the empty-state fix this map exists for silently not applying to
 * either family. Named by hand instead, which means a metric added to either family later has to
 * be added here too. SLEEP_METRICS is reused rather than re-typed, since sleep-derive.test.ts
 * already holds it equal to what deriveSleepDay emits and a second copy here could only drift from
 * it; no equivalent list is exported for workouts, so those two are spelled out against
 * derive/exercise.ts's own two push() calls instead.
 */
for (const metric of SLEEP_METRICS) DATA_TYPE_BY_METRIC.set(metric, 'sleep')
for (const metric of ['workout_count', 'workout_minutes']) DATA_TYPE_BY_METRIC.set(metric, 'exercise')

/**
 * Which catalogue entry produces a metric, or null when none does.
 *
 * This is what lets a chart tell "you turned this off" apart from "nothing has been recorded":
 * the two used to be indistinguishable once a person could exclude a type from sync, since an
 * excluded type's series comes back with zero rows the same way a genuinely quiet period does.
 */
export function dataTypeForMetric(metric: string): string | null {
  return DATA_TYPE_BY_METRIC.get(metric) ?? null
}
