import { DATA_TYPES } from './catalogue.ts'

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
 * Which catalogue entry produces a metric, or null when none does.
 *
 * This is what lets a chart tell "you turned this off" apart from "nothing has been recorded":
 * the two used to be indistinguishable once a person could exclude a type from sync, since an
 * excluded type's series comes back with zero rows the same way a genuinely quiet period does.
 */
export function dataTypeForMetric(metric: string): string | null {
  return DATA_TYPE_BY_METRIC.get(metric) ?? null
}
