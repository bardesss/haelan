import { useCallback } from 'react'
import type { EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, SYMBOL } from './base.js'
import { scaleStops, type ChartTokens } from './tokens.js'
import { calendarLayout, WEEKDAY_LABELS } from './calendar.js'
import { ChartFigure } from './ChartFigure.js'
import type { DayRow } from '../fixtures/july.js'

export function ActivityHeatmap({ days, max, label }: { days: DayRow[]; max: number; label: string }) {
  const { weeks, cells } = calendarLayout(days.map((d) => d.date))

  const build = useCallback((t: ChartTokens): EChartsOption => {
    const base = chartBase(t)
    const worn = cells.flatMap((c, i) => {
      const steps = days[i]?.steps
      return steps === null || steps === undefined ? [] : [[c.week, c.weekday, steps]]
    })
    // Absence gets its own mark rather than an unpainted cell. A cell that is
    // simply not drawn is indistinguishable from a cell at the bottom of the
    // scale, which is the failure this whole ramp exists to avoid.
    const absent = cells.flatMap((c, i) => (days[i]?.steps === null ? [[c.week, c.weekday]] : []))
    return {
      grid: base.grid({ left: 30, top: 10, bottom: 20 }),
      tooltip: base.tooltip,
      xAxis: {
        type: 'category' as const,
        data: Array.from({ length: weeks }, (_, i) => `Week ${i + 1}`),
        axisLabel: { show: false }, splitArea: { show: false }, ...base.hiddenAxis,
      },
      yAxis: {
        type: 'category' as const, data: [...WEEKDAY_LABELS],
        axisLabel: base.axisLabel, ...base.hiddenAxis,
      },
      visualMap: { min: 0, max, show: false, inRange: { color: scaleStops(t) } },
      series: [
        {
          type: 'heatmap' as const,
          data: worn,
          itemStyle: { borderRadius: 2, borderWidth: 1, borderColor: t.surface },
          emphasis: { itemStyle: { borderColor: t.axis } },
        },
        {
          type: 'scatter' as const,
          symbolSize: SYMBOL.noData * 2,
          itemStyle: { color: t.noData },
          data: absent,
        },
      ],
    }
  }, [cells, days, weeks, max])

  const { host, style } = useChart(build, 110)
  return (
    <ChartFigure label={label} host={host} style={style}
      table={{
        columns: ['Date', 'Weekday', 'Steps'],
        rows: cells.map((c, i) => [c.date, WEEKDAY_LABELS[c.weekday] ?? '', days[i]?.steps ?? 'not worn']),
      }} />
  )
}
