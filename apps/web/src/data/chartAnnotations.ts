import { parseDayMetricTarget } from '@haelan/core/target-key'
import type { StoredOverride } from './useAnnotations.js'

/**
 * What one metric's chart needs to draw the overrides that touch it: which days carry an active
 * override and the reason each one gives.
 *
 * Both actions land here, not only `exclude`. `/series` already returns a corrected day's
 * corrected value, so the headline number above a card and the point a chart draws for that day
 * agree the moment a correction applies; without a mark on the chart itself, that agreement would
 * read as "this is what the device measured," which is exactly the silent rewrite a correction
 * must not commit. Marking a corrected day the same way an excluded one is marked, with its own
 * reason as the note, is what keeps the chart honest that a person's word replaced the device's.
 */
export interface MetricAnnotations {
  excluded: string[]
  annotations: { date: string; text: string }[]
}

// One shared instance for every metric no override has ever touched, the same device
// useMetricGroups.ts's own EMPTY is: a fresh { excluded: [], annotations: [] } literal on every
// render would hand a chart's build callback a new identity every time, and useChart disposes and
// re-initialises the whole chart whenever that identity changes (see chart-lifecycle.test.tsx).
const NONE: MetricAnnotations = Object.freeze({
  excluded: Object.freeze([]) as never[],
  annotations: Object.freeze([]) as never[],
})

/**
 * Every `day_metric` override a person has written, grouped by the metric it targets.
 *
 * `sample` and `session` scoped rows are dropped here: this milestone's panel only ever writes
 * `day_metric` (`AnnotatePanel.tsx`'s own `targetKey` is built with `dayMetricTarget` alone), and
 * neither of the other two scopes names a metric a by-day chart could place a mark against. A
 * target key this build cannot parse, whether a future scope or a row written by a version ahead
 * of this one, is skipped the same way rather than taking the whole page down over one row it does
 * not understand yet.
 *
 * Called once per page from the one `overrides` query `useAnnotations` already issues, and meant
 * to be memoised there on `overrides.data`: this function is pure, but the Map and every array
 * inside it must keep the same identity across a render that changed nothing, for the reason
 * `NONE` above is a single frozen instance rather than a fresh literal per call.
 */
export function overridesByMetric(items: readonly StoredOverride[]): Map<string, MetricAnnotations> {
  const map = new Map<string, { excluded: string[]; annotations: { date: string; text: string }[] }>()
  for (const item of items) {
    if (item.scope !== 'day_metric') continue
    let target
    try {
      target = parseDayMetricTarget(item.targetKey)
    } catch {
      continue
    }
    const entry = map.get(target.metric) ?? { excluded: [], annotations: [] }
    entry.excluded.push(target.localDate)
    entry.annotations.push({ date: target.localDate, text: item.reason })
    map.set(target.metric, entry)
  }
  return map
}

/** `byMetric`'s own entry for `metric`, or the shared empty pair when nothing targets it. */
export function annotationsFor(byMetric: Map<string, MetricAnnotations>, metric: string): MetricAnnotations {
  return byMetric.get(metric) ?? NONE
}
