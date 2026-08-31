import { parseDayMetricTarget } from '@haelan/core/target-key'
import type { StoredOverride } from './useAnnotations.js'

/**
 * What one metric's chart needs to draw the overrides that touch it: which days were excluded,
 * which were corrected (and to what), and the reason each one gives.
 *
 * `excluded` and `corrected` are kept apart, not folded into one mark. `/series` already returns a
 * corrected day's corrected value, so the headline number above a card and the point a chart draws
 * for that day agree the moment a correction applies; without any mark at all, that agreement would
 * read as "this is what the device measured," which is the silent rewrite a correction must not
 * commit. But a corrected day was not dropped the way an excluded one was: its replacement value is
 * the number on screen, and telling a reader (sighted or on a screen reader) "excluded" over a
 * number that is very much still there says the opposite of what happened. So each action gets its
 * own channel; `reason` still reaches both through `annotations`, since that part of the story
 * (why) does not depend on which of the two things actually happened.
 */
export interface MetricAnnotations {
  excluded: string[]
  corrected: { date: string; value: number }[]
  annotations: { date: string; text: string }[]
}

// One shared instance for every metric no override has ever touched, the same device
// useMetricGroups.ts's own EMPTY is: a fresh { excluded: [], corrected: [], annotations: [] }
// literal on every render would hand a chart's build callback a new identity every time, and
// useChart disposes and re-initialises the whole chart whenever that identity changes (see
// chart-lifecycle.test.tsx).
const NONE: MetricAnnotations = Object.freeze({
  excluded: Object.freeze([]) as never[],
  corrected: Object.freeze([]) as never[],
  annotations: Object.freeze([]) as never[],
})

/**
 * Every `day_metric` override a person has written, grouped by the metric it targets.
 *
 * `sample` and `session` scoped rows are dropped here: this milestone's panel only ever writes
 * `day_metric` (`AnnotatePanel.tsx`'s own `targetKey` is built with `dayMetricTarget` alone), and
 * neither of the other two scopes names a metric a by-day chart could place a mark against.
 *
 * A target key this build cannot parse is skipped the same way, not thrown: `parseDayMetricTarget`
 * throws on a row a future scope or a version ahead of this one wrote in a shape this build does
 * not recognise, and one row from tomorrow's schema must not take today's chart down. This is a
 * real guard, not defensive dressing; chartAnnotations.test.ts pins it against a malformed row
 * sitting beside two good ones.
 *
 * A `correct` override with no `correctedValue` is dropped from `corrected` for the same reason:
 * the panel's own `canSubmit` never lets that combination be written, so a row like that can only
 * be a defect somewhere upstream of this read, and drawing a corrected mark with nothing to anchor
 * it at would be worse than not drawing one. Its `reason` still reaches `annotations`, since that
 * much of the row is not in question.
 *
 * Called once per page from the one `overrides` query `useAnnotations` already issues, and meant
 * to be memoised there on `overrides.data`: this function is pure, but the Map and every array
 * inside it must keep the same identity across a render that changed nothing, for the reason
 * `NONE` above is a single frozen instance rather than a fresh literal per call.
 */
export function overridesByMetric(items: readonly StoredOverride[]): Map<string, MetricAnnotations> {
  const map = new Map<string, { excluded: string[]; corrected: { date: string; value: number }[]; annotations: { date: string; text: string }[] }>()
  for (const item of items) {
    if (item.scope !== 'day_metric') continue
    let target
    try {
      target = parseDayMetricTarget(item.targetKey)
    } catch {
      continue
    }
    const entry = map.get(target.metric) ?? { excluded: [], corrected: [], annotations: [] }
    if (item.action === 'exclude') {
      entry.excluded.push(target.localDate)
    } else if (item.correctedValue !== null) {
      entry.corrected.push({ date: target.localDate, value: item.correctedValue })
    }
    entry.annotations.push({ date: target.localDate, text: item.reason })
    map.set(target.metric, entry)
  }
  return map
}

/** `byMetric`'s own entry for `metric`, or the shared empty triple when nothing targets it. */
export function annotationsFor(byMetric: Map<string, MetricAnnotations>, metric: string): MetricAnnotations {
  return byMetric.get(metric) ?? NONE
}
