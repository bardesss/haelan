import { useCallback } from 'react'
import type { EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, OPACITY, STROKE, SYMBOL } from './base.js'
import type { ChartTokens } from './tokens.js'
import { hrTooltip } from './hrTooltip.js'
import { ChartFigure } from './ChartFigure.js'
import type { DayRow } from '../fixtures/july.js'

type Props = {
  days: DayRow[]
  baseline: { low: number; high: number }
  annotations: { date: string; text: string }[]
  excluded: string[]
  label: string
}

export function HeartRateRange({ days, baseline, annotations, excluded, label }: Props) {
  const build = useCallback((t: ChartTokens): EChartsOption => {
    const base = chartBase(t)
    return {
      grid: base.grid({ top: 18 }),
      tooltip: {
        ...base.tooltip,
        trigger: 'axis' as const,
        formatter: (params) => hrTooltip(days, (Array.isArray(params) ? params[0] : params)?.dataIndex),
      },
      xAxis: { type: 'category' as const, data: days.map((d) => d.date.slice(8)), ...base.labelledAxis },
      yAxis: { type: 'value' as const, scale: true, splitLine: base.splitLine, axisLabel: base.axisLabel },
      series: [
        { name: 'min', type: 'line' as const, data: days.map((d) => d.hrMin), showSymbol: false, connectNulls: false,
          lineStyle: { opacity: 0 }, stack: 'range', areaStyle: { opacity: 0 } },
        { name: 'range', type: 'line' as const, data: days.map((d) => (d.hrMax !== null && d.hrMin !== null ? d.hrMax - d.hrMin : null)),
          showSymbol: false, connectNulls: false, lineStyle: { opacity: 0 }, stack: 'range',
          areaStyle: { color: t.stageLight, opacity: OPACITY.rangeBand } },
        { name: 'mean', type: 'line' as const, data: days.map((d) => d.hrMean), showSymbol: false, connectNulls: false,
          lineStyle: { width: STROKE.series, color: t.series },
          markArea: { silent: true, itemStyle: { color: t.band, opacity: OPACITY.baselineBand },
            data: [[{ yAxis: baseline.low }, { yAxis: baseline.high }]] },
          markPoint: { symbolSize: SYMBOL.excluded, itemStyle: { color: t.excluded },
            // markPoint's explicit coordinates skip axis extent calculation, so a placeholder y lands off the fitted range.
            // Anchor each marker at the day's actual mean instead, and drop it if that day has no reading.
            data: excluded.flatMap((date) => {
              const day = days.find((d) => d.date === date)
              if (!day || day.hrMean === null) return []
              return [{ name: 'excluded', xAxis: date.slice(8), yAxis: day.hrMean }]
            }) },
          markLine: { symbol: 'circle', lineStyle: { color: t.stageAwake, type: 'dashed' as const },
            label: { color: t.stageAwake, fontSize: base.axisLabel.fontSize, formatter: (p: { name: string }) => p.name },
            data: annotations.map((a) => ({ name: a.text, xAxis: a.date.slice(8) })) } },
      ],
    }
  }, [days, baseline, annotations, excluded])

  const { host, style } = useChart(build, 170)
  return (
    <ChartFigure label={label} host={host} style={style}
      table={{
        columns: ['Date', 'Minimum', 'Mean', 'Maximum', 'Note'],
        rows: days.map((d) => [
          d.date,
          d.hrMin ?? 'no reading', d.hrMean ?? 'no reading', d.hrMax ?? 'no reading',
          [!d.worn ? 'not worn' : '', excluded.includes(d.date) ? 'excluded' : '',
            annotations.find((a) => a.date === d.date)?.text ?? ''].filter(Boolean).join(', '),
        ]),
      }} />
  )
}
