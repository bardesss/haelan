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
