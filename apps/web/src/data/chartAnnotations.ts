import { parseDayMetricTarget } from '@haelan/core/target-key'
import type { StoredOverride } from './useAnnotations.js'

/**
 * What one metric's chart needs to draw the overrides that touch it: which days were excluded, and
 * the reason each one gives.
 *
 * There is no `corrected` channel, and its absence is a fact about what can be written rather than
 * a gap to fill in. `POST /overrides` is the only writer of an override row anywhere in this
 * project, and OverrideStore.validate refuses `correct` at every scope but `sample`, while this
 * function keeps only `day_metric` rows; the two conditions cannot both hold. It was here, drawing
 * a mark nothing could ever populate, and three tests certified that rendering for a row the server
 * refuses to create.
 *
 * Restoring it would not be dormant, it would lie. deriveDay consults only `excludedMetrics`, so
 * even if a day scoped correction were inserted past the route, the plotted value would still be
 * the uncorrected one and the chart would name a replacement the number under the mark does not
 * have. A milestone that adds day level corrections has to change OverrideStore.validate and
 * deriveDay first, and this file's callers already import both.
 *
 * Corrections themselves are alive at `sample` scope, where the route accepts them and
 * `applyToSamples` genuinely rewrites the reading at derivation. Nothing on a by-day chart can draw
 * one: a sample target names an instant, not a day. IntradayHeartRate is the one chart a sample
 * override touches at all, and it touches the two actions differently: a sample exclusion is
 * marked on the chart (readIntraday's own `excluded` field on each plotted point), while a sample
 * correction changes the values readIntraday hands back — the point moves, nothing is drawn on it.
 * The settings override list reads every override back regardless of which chart, if any, its
 * effect is visible on.
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
 * neither of the other two scopes names a metric a by-day chart could place a mark against.
 *
 * A target key this build cannot parse is skipped the same way, not thrown: `parseDayMetricTarget`
 * throws on a row a future scope or a version ahead of this one wrote in a shape this build does
 * not recognise, and one row from tomorrow's schema must not take today's chart down. This is a
 * real guard, not defensive dressing; chartAnnotations.test.ts pins it against a malformed row
 * sitting beside two good ones.
 *
 * Only an `exclude` row reaches `excluded`, and nothing else has a channel of its own: see
 * MetricAnnotations above for why a day scoped correction cannot be written and would draw a false
 * claim if it were. A row that is somehow neither still contributes its `reason` to `annotations`,
 * since a reason a person wrote is theirs whatever the row around it turned out to be.
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
    if (item.action === 'exclude') entry.excluded.push(target.localDate)
    entry.annotations.push({ date: target.localDate, text: item.reason })
    map.set(target.metric, entry)
  }
  return map
}

/** `byMetric`'s own entry for `metric`, or the shared empty pair when nothing targets it. */
export function annotationsFor(byMetric: Map<string, MetricAnnotations>, metric: string): MetricAnnotations {
  return byMetric.get(metric) ?? NONE
}
