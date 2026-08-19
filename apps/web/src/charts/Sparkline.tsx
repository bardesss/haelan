import { useCallback } from 'react'
import { useChart } from './useChart.js'
import type { ChartTokens } from './tokens.js'

export function Sparkline({ values, height = 34 }: { values: (number | null)[]; height?: number }) {
  const build = useCallback((t: ChartTokens) => ({
    grid: { left: 0, right: 0, top: 4, bottom: 4 },
    xAxis: { type: 'category' as const, show: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value' as const, show: false, scale: true },
    series: [{ type: 'line' as const, data: values, showSymbol: false, connectNulls: false,
      lineStyle: { width: 1.6, color: t.series } }],
  }), [values])

  const { host, style } = useChart(build, height)
  return <div ref={host} style={style} />
}
