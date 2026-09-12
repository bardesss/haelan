import { useCallback } from 'react'
import type { EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase } from './base.js'
import { scaleStops } from './tokens.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatDuration } from '../format.js'

export interface ZoneRow { zone: string, label: string, minutes: number }

const HEIGHT = 48

/**
 * One horizontal stacked bar: the session's time in each zone, in order, on the sequential ramp.
 *
 * The ramp rather than four hand-picked colours, because zones are ordered - light through peak is
 * a scale, not four categories - and scaleStops is the ordered ramp this app already publishes.
 * The first four of its five stops, lightest first, so the drawn order matches the read order.
 */
export function ZoneBar({ rows, label }: { rows: readonly ZoneRow[], label: string }) {
  const { t } = useTranslation()

  const build = useCallback((tokens: ChartTokens): EChartsOption => {
    const base = chartBase(tokens)
    const stops = scaleStops(tokens)
    return {
      grid: base.grid({ left: 8, right: 8, top: 8, bottom: 8 }),
      tooltip: {
        ...base.tooltip,
        trigger: 'item' as const,
        formatter: (params: unknown) => {
          const p = params as { seriesName?: string, value?: number }
          return `${p.seriesName ?? ''}: ${formatDuration(Number(p.value ?? 0))}`
        },
      },
      xAxis: { type: 'value' as const, ...base.hiddenAxis, max: rows.reduce((a, r) => a + r.minutes, 0) || 1 },
      yAxis: { type: 'category' as const, data: [label], ...base.hiddenAxis },
      series: rows.map((row, index) => ({
        name: row.label,
        type: 'bar' as const,
        stack: 'zones',
        data: [row.minutes],
        itemStyle: { color: stops[index % stops.length]! },
      })),
    }
  }, [rows, label])

  const { host, style } = useChart(build, HEIGHT)

  return (
    <ChartFigure
      label={label}
      host={host}
      style={style}
      table={{
        columns: [t('activity.workout.zones.column'), t('activity.units.minutes')],
        rows: rows.map((row) => [row.label, formatDuration(row.minutes)]),
      }}
    />
  )
}
