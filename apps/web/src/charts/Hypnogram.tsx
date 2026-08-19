import { useCallback } from 'react'
import type { EChartsOption, CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase } from './base.js'
import type { ChartTokens } from './tokens.js'
import type { Stage } from '../fixtures/july.js'
import { stageColor } from './stage.js'
import { ChartFigure } from './ChartFigure.js'
import { formatDuration } from '../format.js'

const LANES: Stage[] = ['awake', 'rem', 'light', 'deep']
const STAGE_LABEL: Record<Stage, string> = { deep: 'Deep', light: 'Light', rem: 'REM', awake: 'Awake' }

export function Hypnogram({ segments, startLabel, label }: {
  segments: { stage: Stage; from: number; to: number }[]
  startLabel: string
  label: string
}) {
  const build = useCallback((t: ChartTokens): EChartsOption => {
    const base = chartBase(t)
    return {
      grid: base.grid({ left: 46, top: 10 }),
      xAxis: { type: 'value' as const, min: 0, max: segments.at(-1)?.to ?? 480,
        axisLabel: { ...base.axisLabel, formatter: (v: number) => `${Math.floor(v / 60)}h` },
        splitLine: base.splitLine },
      yAxis: { type: 'category' as const, data: [...LANES].reverse(),
        axisLabel: base.axisLabel, ...base.hiddenAxis },
      series: [{
        type: 'custom' as const,
        renderItem: (_params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
          const laneIndex = Number(api.value(2))
          const stage = LANES[LANES.length - 1 - laneIndex] ?? 'light'
          const start = api.coord([Number(api.value(0)), laneIndex])
          const end = api.coord([Number(api.value(1)), laneIndex])
          // api.size() is typed number | number[] for other coord systems; a category/value grid always returns [x, y].
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
      graphic: [{ type: 'text' as const, left: 46, top: 0,
        style: { text: startLabel, fill: t.muted, fontSize: base.axisLabel.fontSize } }],
    }
  }, [segments, startLabel])

  const { host, style } = useChart(build, 130)
  return (
    <ChartFigure label={label} host={host} style={style}
      table={{
        columns: ['From', 'To', 'Stage', 'Duration'],
        rows: segments.map((s) => [
          formatDuration(s.from), formatDuration(s.to), STAGE_LABEL[s.stage], formatDuration(s.to - s.from),
        ]),
      }} />
  )
}
