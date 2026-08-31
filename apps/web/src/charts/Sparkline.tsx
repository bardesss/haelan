import { useCallback } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { STROKE, OPACITY, SYMBOL } from './base.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'

/**
 * Which local date a click on this sparkline's own series landed on, or undefined for a click
 * that missed the line (empty space) or landed on the markPoint/markLine overlays instead: those
 * report a "series" of their own kind (`markPoint`/`markLine`) rather than `componentType:
 * 'series'`, and their dataIndex counts into the overlay's own data array, not `labels`.
 *
 * A plain function, exported and tested on its own: echarts renders to an SVG this project's own
 * render environment cannot hit-test (see chart-annotations.test.tsx's own note), so the
 * translation from a click event to a date is the one piece of this behaviour a test can reach.
 */
export function sparklinePointDate(labels: string[], event: Pick<ECElementEvent, 'componentType' | 'dataIndex'>): string | undefined {
  if (event.componentType !== 'series') return undefined
  return labels[event.dataIndex]
}

// A stable reference for a caller that omits annotations/excluded, the same device Dashboard.tsx's
// own EMPTY constant uses: a default parameter expression that is a fresh `[]` literal runs on
// every call, handing `build`'s useCallback a new array identity on every render regardless of
// what actually changed, which is precisely the defect chart-lifecycle.test.tsx guards against.
const EMPTY = Object.freeze([]) as never[]

// No grid or ticks: a sparkline is a shape, not a chart to consult; the table carries the numbers it stands in for.
export function Sparkline({ values, labels, label, unit, baseline, height = 34, annotations = EMPTY, excluded = EMPTY, corrected = EMPTY, onPointClick }: {
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
  // Same prop names and shapes HeartRateRange has taken since D1, so a page hands every chart type
  // the same annotations/excluded/corrected values instead of building a different shape per chart.
  // Optional here (HeartRateRange's own trio is required) because Sparkline's own default parameter
  // (EMPTY, below) has to exist regardless: a page can still mount a card before its overrides query
  // has answered.
  annotations?: { date: string; text: string }[]
  excluded?: string[]
  // Kept apart from `excluded`: a corrected day was not dropped, its replacement value is the
  // number already on screen, so marking it "excluded" would tell a reader the opposite of what
  // happened. See chartAnnotations.ts's own doc comment on `MetricAnnotations` for the full reasoning.
  corrected?: { date: string; value: number }[]
  onPointClick?: (localDate: string) => void
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
        data: [[{ yAxis: baseline.low }, { yAxis: baseline.high }]] } }),
      markPoint: { symbolSize: SYMBOL.excluded, itemStyle: { color: tokens.excluded },
        // markPoint's explicit coordinates skip axis extent calculation, so a placeholder y lands
        // off the fitted range; anchor at the day's own value instead, same as HeartRateRange, and
        // drop a date this sparkline has no reading for (nothing to anchor the mark to). corrected
        // entries share this same markPoint (echarts draws one per series) but override symbol and
        // colour so the two read apart at a glance. `seriesAlt`, not `stageRem`: this project's own
        // token catalogue defines it and nothing on any of these three charts had claimed it yet,
        // where `stageRem` already means REM sleep on Hypnogram, a chart that shares a screen with
        // HeartRateRange on the Dashboard - one colour carrying two meanings in one view.
        data: [
          ...excluded.flatMap((date) => {
            const i = labels.indexOf(date)
            const v = i === -1 ? null : values[i]
            if (v === null || v === undefined) return []
            return [{ name: 'excluded', xAxis: i, yAxis: v }]
          }),
          ...corrected.flatMap((c) => {
            const i = labels.indexOf(c.date)
            const v = i === -1 ? null : values[i]
            if (v === null || v === undefined) return []
            return [{ name: 'corrected', symbol: 'rect', symbolSize: SYMBOL.corrected,
              itemStyle: { color: tokens.seriesAlt }, xAxis: i, yAxis: v }]
          }),
        ] },
      markLine: { symbol: 'circle', lineStyle: { color: tokens.stageAwake, type: 'dashed' as const },
        label: { show: false },
        data: annotations.flatMap((a) => {
          const i = labels.indexOf(a.date)
          return i === -1 ? [] : [{ name: a.text, xAxis: i }]
        }) } }],
  }), [values, baseline, excluded, corrected, annotations, labels])

  const onClick = useCallback((event: ECElementEvent) => {
    const date = sparklinePointDate(labels, event)
    if (date !== undefined) onPointClick?.(date)
  }, [labels, onPointClick])

  const { host, style } = useChart(build, height, onClick)
  return (
    <>
      <ChartFigure label={label} host={host} style={style}
        table={{
          columns: [t('charts.columns.date'), unit, t('charts.columns.note')],
          rows: values.map((v, i) => {
            const date = labels[i] ?? String(i)
            const correctedEntry = corrected.find((c) => c.date === date)
            return [date, v ?? t('charts.absence.noReading'),
              [excluded.includes(date) ? t('charts.absence.excluded') : '',
                correctedEntry ? t('charts.absence.correctedTo', { value: correctedEntry.value }) : '',
                annotations.find((a) => a.date === date)?.text ?? ''].filter(Boolean).join(', ')]
          }),
        }} />
      {/* The band itself is drawn on the chart's canvas (markArea above), which a test cannot
          query. Same deliberate, invisible seam as HeartRateRange's own sentinel, so a test can
          assert the band's presence without depending on echarts' internal structure. */}
      {baseline && <span data-baseline-band aria-hidden="true" style={{ display: 'none' }} />}
    </>
  )
}
