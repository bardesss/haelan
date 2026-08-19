import type { ChartTokens } from './tokens.js'

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

export const AXIS_FONT_SIZE = 12

type Inset = { left?: number; right?: number; top?: number; bottom?: number }

export function chartBase(t: ChartTokens) {
  const axisLabel = { color: t.axis, fontSize: AXIS_FONT_SIZE }
  return {
    axisLabel,
    // Gridlines and axis lines share a colour deliberately: dark theme contrast here is 1.04:1 (chart-styling.md section 2).
    splitLine: { lineStyle: { color: t.grid } },
    axisLine: { lineStyle: { color: t.grid } },
    hiddenAxis: { axisLine: { show: false }, axisTick: { show: false } },
    tooltip: { backgroundColor: t.tooltipBg, borderColor: t.grid, textStyle: { color: t.muted } },
    grid: (inset: Inset = {}) => ({ left: 34, right: 12, top: 12, bottom: 24, ...inset }),
    labelledAxis: { axisLabel, axisLine: { lineStyle: { color: t.grid } } },
  }
}
