import { useCallback } from 'react'
import type { EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import type { ChartTokens } from './tokens.js'
import type { DayRow } from '../fixtures/july.js'

export function ActivityHeatmap({ days }: { days: DayRow[] }) {
  const build = useCallback((t: ChartTokens): EChartsOption => ({
    grid: { left: 30, right: 12, top: 10, bottom: 20 },
    tooltip: { backgroundColor: t.surface, borderColor: t.grid, textStyle: { color: t.muted } },
    xAxis: { type: 'category' as const, data: days.map((_, i) => Math.floor(i / 7)),
      axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false }, splitArea: { show: false } },
    yAxis: { type: 'category' as const, data: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
      axisLabel: { color: t.axis, fontSize: 9 }, axisLine: { show: false }, axisTick: { show: false } },
    visualMap: { min: 0, max: 18000, show: false, inRange: { color: [t.band, t.stageLight, t.stageRem] } },
    series: [{
      type: 'heatmap' as const,
      // steps stays null for unworn days; ECharts skips null cells rather than
      // drawing them at the low end of the scale, so absence never reads as zero.
      data: days.map((d, i) => [Math.floor(i / 7), i % 7, d.steps]),
      itemStyle: { borderRadius: 2, borderWidth: 1, borderColor: t.surface },
      emphasis: { itemStyle: { borderColor: t.axis } },
    }],
  }), [days])

  const { host, style } = useChart(build, 110)
  return <div ref={host} style={style} />
}
