import { useCallback } from 'react'
import type { EChartsOption, CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, STROKE, SYMBOL } from './base.js'
import type { ChartTokens } from './tokens.js'
import { nightMark, type Night } from './schedule.js'
import { ChartFigure } from './ChartFigure.js'
import { formatClock } from '../format.js'
import { useTranslation } from '../i18n/index.js'

// Noon to noon: shifted rather than widened, so naps at 13:00 fit without compressing the sleep band.
export const AXIS_MIN = 12 * 60
export const AXIS_MAX = 36 * 60

// Parked above every real span: inside the range it once read as an unusually early wake time.
export const NO_DATA_Y = 35 * 60

export function SleepSchedule({ nights, label, showNaps = true }: { nights: Night[]; label: string; showNaps?: boolean }) {
  const { t } = useTranslation()

  const build = useCallback((tokens: ChartTokens): EChartsOption => {
    const base = chartBase(tokens)
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
            const mark = nightMark(night, tokens)
            // Missing bed/wake is absence, not a zero-length span: draw a no-data mark so the gap stays visible.
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
        // Omitted rather than left to draw nothing: a caller passing showNaps=false is telling
        // this chart it has no nap data at all, and a data-less series is still a series, not the
        // same statement as one that was never asked to exist.
        ...(showNaps
          ? [{ type: 'scatter' as const, symbolSize: SYMBOL.nap, itemStyle: { color: tokens.stageAwake },
              data: nights.flatMap((n, i) => n.naps.map((nap) => [i, nap])) }]
          : []),
      ],
    }
  }, [nights, showNaps])

  const { host, style } = useChart(build, 150)
  const baseColumns = [t('charts.columns.night'), t('charts.columns.toBed'), t('charts.columns.woke')]
  // A "none" in a naps column states that a check was made and found nothing; this source has
  // never made that check (see the caller for why), so the honest move is to drop the column
  // rather than fill it with a claim nothing here can back.
  const columns = showNaps ? [...baseColumns, t('charts.columns.naps')] : baseColumns
  const rows = nights.map((n) => {
    const base = [
      n.date,
      n.bed === null ? t('charts.absence.noReading') : formatClock(n.bed),
      n.wake === null ? t('charts.absence.noReading') : formatClock(n.wake),
    ]
    return showNaps
      ? [...base, n.naps.length === 0 ? t('charts.absence.none') : n.naps.map((nap) => formatClock(nap)).join(', ')]
      : base
  })

  return <ChartFigure label={label} host={host} style={style} table={{ columns, rows }} />
}
