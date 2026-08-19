import type { ChartTokens } from './tokens.js'

// Every stroke weight and fill opacity in the chart layer, named once. A number
// that only exists inside one chart's option object is a number the next chart
// copies slightly wrong.
export const STROKE = {
  sparkline: 1.6,
  series: 1.9,
  nightSpan: 5,
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

// Axis labels are the smallest text the app renders. One size everywhere, so a
// reader never has to decide whether a size difference means something.
export const AXIS_FONT_SIZE = 12

type Inset = { left?: number; right?: number; top?: number; bottom?: number }

// The shared fragments every chart's option object is assembled from. A chart
// states only what makes it that chart; everything below is the house style.
export function chartBase(t: ChartTokens) {
  const axisLabel = { color: t.axis, fontSize: AXIS_FONT_SIZE }
  return {
    axisLabel,
    // Gridlines and axis lines are the same colour: they are the same thing to a
    // reader, a faint division of the plot area, not a mark precise enough to
    // read a value off of (see chart-styling.md section 2 on the dark theme's
    // 1.04:1 contrast here).
    splitLine: { lineStyle: { color: t.grid } },
    axisLine: { lineStyle: { color: t.grid } },
    hiddenAxis: { axisLine: { show: false }, axisTick: { show: false } },
    tooltip: { backgroundColor: t.tooltipBg, borderColor: t.grid, textStyle: { color: t.muted } },
    // Right and top insets are constant; left and bottom vary with how much room
    // that chart's labels need.
    grid: (inset: Inset = {}) => ({ left: 34, right: 12, top: 12, bottom: 24, ...inset }),
    labelledAxis: { axisLabel, axisLine: { lineStyle: { color: t.grid } } },
  }
}
