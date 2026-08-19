import { useCallback } from 'react'
import type { EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import type { ChartTokens } from './tokens.js'
import type { DayRow } from '../fixtures/july.js'

type Props = {
  days: DayRow[]
  baseline: { low: number; high: number }
  annotations: { date: string; text: string }[]
  excluded: string[]
}

export function HeartRateRange({ days, baseline, annotations, excluded }: Props) {
  const build = useCallback((t: ChartTokens): EChartsOption => ({
    grid: { left: 34, right: 12, top: 18, bottom: 24 },
    tooltip: {
      trigger: 'axis' as const, backgroundColor: t.surface, borderColor: t.grid, textStyle: { color: t.muted },
      // The min/max band is a stacked area under the hood, so the default axis
      // tooltip would show the stacked delta instead of the true max. Rebuild
      // the real values from the day row instead of trusting series data.
      formatter: (params) => {
        const first = Array.isArray(params) ? params[0] : params
        const day = first ? days[first.dataIndex] : undefined
        if (!day) return ''
        if (!day.worn) return `${day.date}<br/>not worn`
        return `${day.date}<br/>mean ${day.hrMean} bpm<br/>range ${day.hrMin}–${day.hrMax} bpm`
      },
    },
    xAxis: { type: 'category' as const, data: days.map((d) => d.date.slice(8)),
      axisLine: { lineStyle: { color: t.grid } }, axisLabel: { color: t.axis, fontSize: 9 } },
    yAxis: { type: 'value' as const, scale: true, splitLine: { lineStyle: { color: t.grid } },
      axisLabel: { color: t.axis, fontSize: 9 } },
    series: [
      { name: 'min', type: 'line' as const, data: days.map((d) => d.hrMin), showSymbol: false, connectNulls: false,
        lineStyle: { opacity: 0 }, stack: 'range', areaStyle: { opacity: 0 } },
      { name: 'range', type: 'line' as const, data: days.map((d) => (d.hrMax !== null && d.hrMin !== null ? d.hrMax - d.hrMin : null)),
        showSymbol: false, connectNulls: false, lineStyle: { opacity: 0 }, stack: 'range',
        areaStyle: { color: t.stageLight, opacity: 0.22 } },
      { name: 'mean', type: 'line' as const, data: days.map((d) => d.hrMean), showSymbol: false, connectNulls: false,
        lineStyle: { width: 1.9, color: t.series },
        markArea: { silent: true, itemStyle: { color: t.band, opacity: 0.5 },
          data: [[{ yAxis: baseline.low }, { yAxis: baseline.high }]] },
        markPoint: { symbolSize: 7, itemStyle: { color: t.excluded },
          data: excluded.map((date) => ({ name: 'excluded', xAxis: date.slice(8), yAxis: 0 })) },
        markLine: { symbol: 'circle', lineStyle: { color: t.stageAwake, type: 'dashed' as const },
          label: { color: t.stageAwake, fontSize: 9, formatter: (p: { name: string }) => p.name },
          data: annotations.map((a) => ({ name: a.text, xAxis: a.date.slice(8) })) } },
    ],
  }), [days, baseline, annotations, excluded])

  const { host, style } = useChart(build, 170)
  return <div ref={host} style={style} />
}
