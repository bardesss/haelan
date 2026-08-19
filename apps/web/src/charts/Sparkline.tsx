import { useCallback } from 'react'
import type { EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { STROKE } from './base.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'

// No grid, no ticks, no labels: a sparkline is a shape, not a chart with a
// coordinate system a reader is meant to consult. The table alternative carries
// the numbers the shape stands in for.
export function Sparkline({ values, labels, label, unit, height = 34 }: {
  values: (number | null)[]
  labels: string[]
  label: string
  unit: string
  height?: number
}) {
  const build = useCallback((t: ChartTokens): EChartsOption => ({
    grid: { left: 0, right: 0, top: 4, bottom: 4 },
    xAxis: { type: 'category' as const, show: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value' as const, show: false, scale: true },
    series: [{ type: 'line' as const, data: values, showSymbol: false, connectNulls: false,
      lineStyle: { width: STROKE.sparkline, color: t.series } }],
  }), [values])

  const { host, style } = useChart(build, height)
  return (
    <ChartFigure label={label} host={host} style={style}
      table={{
        columns: ['Date', unit],
        rows: values.map((v, i) => [labels[i] ?? String(i), v ?? 'no reading']),
      }} />
  )
}
