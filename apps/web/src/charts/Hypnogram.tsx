import { useCallback } from 'react'
import type { EChartsOption, CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts'
import { useChart } from './useChart.js'
import type { ChartTokens } from './tokens.js'
import type { Stage } from '../fixtures/july.js'
import { stageColor } from './stage.js'

const LANES: Stage[] = ['awake', 'rem', 'light', 'deep']

export function Hypnogram({ segments, startLabel }: {
  segments: { stage: Stage; from: number; to: number }[]
  startLabel: string
}) {
  const build = useCallback((t: ChartTokens): EChartsOption => ({
    grid: { left: 46, right: 12, top: 10, bottom: 24 },
    xAxis: { type: 'value' as const, min: 0, max: segments.at(-1)?.to ?? 480,
      axisLabel: { color: t.axis, fontSize: 9, formatter: (v: number) => `${Math.floor(v / 60)}h` },
      splitLine: { lineStyle: { color: t.grid } } },
    yAxis: { type: 'category' as const, data: [...LANES].reverse(),
      axisLabel: { color: t.axis, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false } },
    series: [{
      type: 'custom' as const,
      renderItem: (_params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
        const laneIndex = Number(api.value(2))
        const stage = LANES[LANES.length - 1 - laneIndex] ?? 'light'
        const start = api.coord([Number(api.value(0)), laneIndex])
        const end = api.coord([Number(api.value(1)), laneIndex])
        // size() is typed as number | number[] since some coord systems return a
        // scalar; a category/value grid always gives the [x, y] pair we want.
        const laneSize = api.size?.([0, 1]) ?? 20
        const laneHeight = (Array.isArray(laneSize) ? laneSize[1] : laneSize) ?? 20
        const height = laneHeight * 0.45
        return {
          type: 'rect',
          shape: { x: start[0] ?? 0, y: (start[1] ?? 0) - height / 2, width: (end[0] ?? 0) - (start[0] ?? 0), height },
          style: { fill: stageColor(stage as Stage, t) },
        }
      },
      encode: { x: [0, 1], y: 2 },
      data: segments.map((s) => [s.from, s.to, LANES.length - 1 - LANES.indexOf(s.stage)]),
    }],
    graphic: [{ type: 'text' as const, left: 46, top: 0, style: { text: startLabel, fill: t.muted, fontSize: 9 } }],
  }), [segments, startLabel])

  const { host, style } = useChart(build, 130)
  return <div ref={host} style={style} />
}
