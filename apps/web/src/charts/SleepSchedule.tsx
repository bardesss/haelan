import { useCallback } from 'react'
import type { EChartsOption, CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts'
import { useChart } from './useChart.js'
import type { ChartTokens } from './tokens.js'

type Night = { date: string; bed: number | null; wake: number | null; naps: number[] }

// Sits mid-range so a no-data night reads as a distinct mark, not a stray dot
// lost against an axis edge.
const NO_DATA_Y = (18 + 42) * 30

export function SleepSchedule({ nights }: { nights: Night[] }) {
  const build = useCallback((t: ChartTokens): EChartsOption => ({
    grid: { left: 40, right: 12, top: 12, bottom: 24 },
    xAxis: { type: 'category' as const, data: nights.map((n) => n.date.slice(8)),
      axisLabel: { color: t.axis, fontSize: 9, interval: 4 }, axisLine: { lineStyle: { color: t.grid } } },
    yAxis: { type: 'value' as const, min: 18 * 60, max: 42 * 60, inverse: false,
      axisLabel: { color: t.axis, fontSize: 9, formatter: (v: number) => `${String(Math.floor(v / 60) % 24).padStart(2, '0')}:00` },
      splitLine: { lineStyle: { color: t.grid } } },
    series: [
      { type: 'custom' as const,
        renderItem: (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
          const night = nights[params.dataIndex]
          if (!night) return { type: 'group' as const, children: [] }
          // A missing bed or wake time is absence, not a zero-length span: draw a
          // no-data mark instead of a line so the gap stays visible on the axis.
          if (night.bed === null || night.wake === null) {
            const mark = api.coord([Number(api.value(0)), NO_DATA_Y])
            return {
              type: 'circle',
              shape: { cx: mark[0] ?? 0, cy: mark[1] ?? 0, r: 3 },
              style: { fill: t.noData },
            }
          }
          const top = api.coord([api.value(0), night.bed])
          const bottom = api.coord([api.value(0), night.wake])
          return {
            type: 'line',
            shape: { x1: top[0] ?? 0, y1: top[1] ?? 0, x2: bottom[0] ?? 0, y2: bottom[1] ?? 0 },
            style: { stroke: t.stageLight, lineWidth: 5, lineCap: 'round' },
          }
        },
        encode: { x: 0 },
        data: nights.map((n, i) => [i, n.bed ?? 0]) },
      { type: 'scatter' as const, symbolSize: 6, itemStyle: { color: t.stageAwake },
        data: nights.flatMap((n, i) => n.naps.map((nap) => [i, nap])) },
    ],
  }), [nights])

  const { host, style } = useChart(build, 150)
  return <div ref={host} style={style} />
}
