import { useCallback } from 'react'
import type { EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { STROKE, OPACITY } from './base.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'

// No grid or ticks: a sparkline is a shape, not a chart to consult; the table carries the numbers it stands in for.
export function Sparkline({ values, labels, label, unit, baseline, height = 34 }: {
  values: (number | null)[]
  labels: string[]
  label: string
  unit: string
  // Optional and, when present, never thin: the same rule HeartRateRange's own `baseline` prop
  // documents. A band this project cannot stand behind reads as more authoritative than one built
  // from thirty real days, not less, so the caller (Recovery.tsx) only ever hands this over once
  // its own baseline query has cleared the thin check.
  baseline?: { low: number, high: number }
  height?: number
}) {
  const { t } = useTranslation()

  const build = useCallback((tokens: ChartTokens): EChartsOption => ({
    grid: { left: 0, right: 0, top: 4, bottom: 4 },
    xAxis: { type: 'category' as const, show: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value' as const, show: false, scale: true },
    series: [{ type: 'line' as const, data: values, showSymbol: false, connectNulls: false,
      lineStyle: { width: STROKE.sparkline, color: tokens.series },
      // Same markArea shape HeartRateRange draws its band with: a rectangle between two y values,
      // unbounded on x, so it sits behind the line regardless of how many points there are.
      ...(baseline && { markArea: { silent: true, itemStyle: { color: tokens.band, opacity: OPACITY.baselineBand },
        data: [[{ yAxis: baseline.low }, { yAxis: baseline.high }]] } })}],
  }), [values, baseline])

  const { host, style } = useChart(build, height)
  return (
    <>
      <ChartFigure label={label} host={host} style={style}
        table={{
          columns: [t('charts.columns.date'), unit],
          rows: values.map((v, i) => [labels[i] ?? String(i), v ?? t('charts.absence.noReading')]),
        }} />
      {/* The band itself is drawn on the chart's canvas (markArea above), which a test cannot
          query. Same deliberate, invisible seam as HeartRateRange's own sentinel, so a test can
          assert the band's presence without depending on echarts' internal structure. */}
      {baseline && <span data-baseline-band aria-hidden="true" style={{ display: 'none' }} />}
    </>
  )
}
