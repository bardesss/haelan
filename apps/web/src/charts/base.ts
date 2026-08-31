import type { ChartTokens } from './tokens.js'

export const STROKE = {
  sparkline: 1.6,
  series: 1.9,
  nightSpan: 5,
  // Hairline, because it is there to give the mark an edge the card cannot
  // swallow, not to be seen as a line in its own right.
  stageOutline: 1,
} as const

export const OPACITY = {
  rangeBand: 0.22,
  baselineBand: 0.5,
} as const

export const SYMBOL = {
  nap: 6,
  excluded: 7,
  // Same size as `excluded`: the two marks differ in colour and shape (a corrected point uses
  // `rect`, an excluded one the default pin), not in how much room they take on the chart.
  corrected: 7,
  noData: 3,
} as const

export const AXIS_FONT_SIZE = 12

/**
 * Applies the reader's motion preference to a built option object.
 *
 * useChart re-runs setOption with notMerge on every theme change, so every chart on the page
 * animates again each time - and ECharts animates by default, which nothing here had ever turned
 * off. A stated system preference overrules whatever a chart asked for: it is a statement about
 * the reader, not a default for a chart to weigh against its own preferences.
 *
 * A plain function rather than something wired into chartBase, so the decision is testable
 * without a DOM; the one line that reads the media query lives in useChart.
 */
export function withMotionPreference<T extends object>(option: T, reducedMotion: boolean): T & { animation: boolean } {
  return { ...option, animation: !reducedMotion }
}

/**
 * Collapses `annotations` to one entry per date, joining every text that shares a date with the
 * same `', '` the accessible table already uses for the same purpose (Sparkline/ActivityHeatmap/
 * HeartRateRange's own table row builders, all three filter+join rather than find() for exactly
 * this reason).
 *
 * An override reason, a note and an event can all land on one date now that day level marks
 * merge with the per-metric ones, where before this task an override alone could not: overrides
 * are unique on (person, scope, targetKey), so a (metric, date) pair never carried more than one.
 * A chart drawing one markLine/markPoint entry per annotation, unchanged since before that was
 * possible, put every one of them at the same anchor: echarts 6 defaults a markLine label to
 * `position: 'end'` and a markPoint label to `position: 'inside'`, so more than one annotation on
 * a date drew as several overlapping, unreadable strings on one pixel rather than several marks.
 * Grouping here first, before a chart's own index/coord lookup runs, makes the canvas draw
 * exactly what the table already states about that date: once.
 *
 * Sparkline does not use this: its own annotation markLine draws with `label: { show: false }`,
 * so nothing is drawn there to overlap in the first place, and the underlying data (one entry per
 * annotation) already matches what its table needs.
 */
export function annotationsByDate(
  annotations: readonly { date: string; text: string }[],
): { date: string; text: string }[] {
  const byDate = new Map<string, string[]>()
  for (const a of annotations) {
    const texts = byDate.get(a.date) ?? []
    texts.push(a.text)
    byDate.set(a.date, texts)
  }
  return [...byDate].map(([date, texts]) => ({ date, text: texts.join(', ') }))
}

type Inset = { left?: number; right?: number; top?: number; bottom?: number }

export function chartBase(t: ChartTokens) {
  const axisLabel = { color: t.axis, fontSize: AXIS_FONT_SIZE }
  return {
    axisLabel,
    // Gridlines and axis lines share a colour deliberately; at 1.04:1 in the dark theme they are structure, not a mark to read a value off.
    splitLine: { lineStyle: { color: t.grid } },
    axisLine: { lineStyle: { color: t.grid } },
    hiddenAxis: { axisLine: { show: false }, axisTick: { show: false } },
    tooltip: { backgroundColor: t.tooltipBg, borderColor: t.grid, textStyle: { color: t.muted } },
    grid: (inset: Inset = {}) => ({ left: 34, right: 12, top: 12, bottom: 24, ...inset }),
    labelledAxis: { axisLabel, axisLine: { lineStyle: { color: t.grid } } },
  }
}
