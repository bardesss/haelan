import { useCallback } from 'react'
import type { EChartsOption, CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, STROKE, SYMBOL } from './base.js'
import type { ChartTokens } from './tokens.js'
import { nightMark, type Night } from './schedule.js'
import { ChartFigure } from './ChartFigure.js'
import { formatClock } from '../format.js'

// Noon through noon the next day, not 18:00 through 18:00: the window was
// already a full 24 hours, so the fixture's naps (13:00-16:00, well before any
// recorded bedtime) only needed the window shifted six hours earlier, not
// widened. Widening it would have compressed the bed-to-wake band this chart
// exists to show; shifting it costs nothing because the span stays 1440
// minutes either way. See schedule-marks.test.ts for the coverage this fixes.
export const AXIS_MIN = 12 * 60
export const AXIS_MAX = 36 * 60

// Parked above every real span rather than inside the range they occupy: at
// the axis floor the absence dot once sat ten minutes under a wake-time
// cluster, which reads as an unusually early morning rather than as a night
// with no reading at all.
export const NO_DATA_Y = 35 * 60

export function SleepSchedule({ nights, label }: { nights: Night[]; label: string }) {
  const build = useCallback((t: ChartTokens): EChartsOption => {
    const base = chartBase(t)
    return {
      grid: base.grid({ left: 40 }),
      xAxis: { type: 'category' as const, data: nights.map((n) => n.date.slice(8)),
        ...base.labelledAxis, axisLabel: { ...base.axisLabel, interval: 4 } },
      yAxis: { type: 'value' as const, min: AXIS_MIN, max: AXIS_MAX, inverse: false,
        axisLabel: { ...base.axisLabel, formatter: (v: number) => formatClock(v).slice(0, 2) + ':00' },
        splitLine: base.splitLine },
      series: [
        { type: 'custom' as const,
          renderItem: (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
            const night = nights[params.dataIndex]
            if (!night) return { type: 'group' as const, children: [] }
            const mark = nightMark(night, t)
            // A missing bed or wake time is absence, not a zero-length span: draw a
            // no-data mark instead of a line so the gap stays visible on the axis.
            if (mark.kind === 'no-data') {
              const point = api.coord([Number(api.value(0)), NO_DATA_Y])
              return {
                type: 'circle',
                shape: { cx: point[0] ?? 0, cy: point[1] ?? 0, r: SYMBOL.noData },
                style: { fill: mark.color },
              }
            }
            const top = api.coord([api.value(0), mark.bed])
            const bottom = api.coord([api.value(0), mark.wake])
            return {
              type: 'line',
              shape: { x1: top[0] ?? 0, y1: top[1] ?? 0, x2: bottom[0] ?? 0, y2: bottom[1] ?? 0 },
              style: { stroke: mark.color, lineWidth: STROKE.nightSpan, lineCap: 'round' },
            }
          },
          encode: { x: 0 },
          data: nights.map((n, i) => [i, n.bed]) },
        { type: 'scatter' as const, symbolSize: SYMBOL.nap, itemStyle: { color: t.stageAwake },
          data: nights.flatMap((n, i) => n.naps.map((nap) => [i, nap])) },
      ],
    }
  }, [nights])

  const { host, style } = useChart(build, 150)
  return (
    <ChartFigure label={label} host={host} style={style}
      table={{
        columns: ['Night', 'To bed', 'Woke', 'Naps'],
        rows: nights.map((n) => [
          n.date,
          n.bed === null ? 'no reading' : formatClock(n.bed),
          n.wake === null ? 'no reading' : formatClock(n.wake),
          n.naps.length === 0 ? 'none' : n.naps.map((nap) => formatClock(nap)).join(', '),
        ]),
      }} />
  )
}
