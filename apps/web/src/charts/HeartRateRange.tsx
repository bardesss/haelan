import { useCallback } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, OPACITY, STROKE, SYMBOL } from './base.js'
import type { ChartTokens } from './tokens.js'
import { hrTooltip } from './hrTooltip.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import type { DayRow } from '../fixtures/july.js'

type Props = {
  days: DayRow[]
  // Optional and, when present, never thin: the call site only ever passes a baseline that
  // cleared useBaseline's own thin check, since a band this project cannot stand behind reads as
  // more authoritative than a band built from thirty real days, not less.
  baseline?: { low: number; high: number }
  annotations: { date: string; text: string }[]
  excluded: string[]
  // Kept apart from `excluded`: a corrected day was not dropped, its replacement value is the
  // number already on screen (`days[i].hrMean` is the corrected mean, not the raw one, once
  // `/series` has applied the override), so marking it "excluded" would tell a reader the opposite
  // of what happened. See chartAnnotations.ts's own doc comment on `MetricAnnotations`.
  corrected: { date: string; value: number }[]
  label: string
  onPointClick?: (localDate: string) => void
}

/**
 * Which local date a click on this chart's own min/range/mean series landed on, or undefined for a
 * click that missed all three (a markPoint/markLine overlay, or empty grid space): an overlay click
 * reports its own componentType rather than `'series'`. All three series share one category axis
 * (`days`, by position), so `dataIndex` resolves to the same day regardless of which of the three
 * was actually clicked.
 *
 * A plain function, exported and tested on its own, the same device Sparkline's own
 * `sparklinePointDate` and ActivityHeatmap's own `heatmapClickDate` are: echarts renders to an SVG
 * this project's render environment cannot hit-test, so the translation from a click event to a
 * date is the one piece of this behaviour a test can reach. See chart-annotations.test.tsx.
 */
export function heartRateRangePointDate(days: DayRow[], event: Pick<ECElementEvent, 'componentType' | 'dataIndex'>): string | undefined {
  if (event.componentType !== 'series') return undefined
  return days[event.dataIndex]?.date
}

export function HeartRateRange({ days, baseline, annotations, excluded, corrected, label, onPointClick }: Props) {
  const { t } = useTranslation()

  const build = useCallback((tokens: ChartTokens): EChartsOption => {
    const base = chartBase(tokens)
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
          areaStyle: { color: tokens.stageLight, opacity: OPACITY.rangeBand } },
        { name: 'mean', type: 'line' as const, data: days.map((d) => d.hrMean), showSymbol: false, connectNulls: false,
          lineStyle: { width: STROKE.series, color: tokens.series },
          ...(baseline && { markArea: { silent: true, itemStyle: { color: tokens.band, opacity: OPACITY.baselineBand },
            data: [[{ yAxis: baseline.low }, { yAxis: baseline.high }]] } }),
          markPoint: { symbolSize: SYMBOL.excluded, itemStyle: { color: tokens.excluded },
            // markPoint's explicit coordinates skip axis extent calculation, so a placeholder y lands off the fitted range.
            // Anchor each marker at the day's actual mean instead, and drop it if that day has no reading. corrected
            // entries share this same markPoint (echarts draws one per series) but override symbol and colour so the
            // two read apart at a glance, the same split Sparkline's own markPoint draws.
            data: [
              ...excluded.flatMap((date) => {
                const day = days.find((d) => d.date === date)
                if (!day || day.hrMean === null) return []
                return [{ name: 'excluded', xAxis: date.slice(8), yAxis: day.hrMean }]
              }),
              ...corrected.flatMap((c) => {
                const day = days.find((d) => d.date === c.date)
                if (!day || day.hrMean === null) return []
                return [{ name: 'corrected', symbol: 'rect', symbolSize: SYMBOL.corrected,
                  itemStyle: { color: tokens.stageRem }, xAxis: c.date.slice(8), yAxis: day.hrMean }]
              }),
            ] },
          markLine: { symbol: 'circle', lineStyle: { color: tokens.stageAwake, type: 'dashed' as const },
            label: { color: tokens.stageAwake, fontSize: base.axisLabel.fontSize, formatter: (p: { name: string }) => p.name },
            // Filtered against `days`, the same way the markPoint four lines up already is: this
            // chart's x axis is `days.map(d => d.date.slice(8))`, a day-of-month label that repeats
            // every month, and an override from outside the visible range shares that same label
            // with whatever day in the current range happens to fall on the same day-of-month. An
            // unfiltered `annotations.map` used to place that override's markLine on the wrong day
            // in the range being drawn; found by chart-annotations.test.tsx's own regression case.
            data: annotations.flatMap((a) => {
              const day = days.find((d) => d.date === a.date)
              return day ? [{ name: a.text, xAxis: a.date.slice(8) }] : []
            }) } },
      ],
    }
  }, [days, baseline, annotations, excluded, corrected])

  const onClick = useCallback((event: ECElementEvent) => {
    const date = heartRateRangePointDate(days, event)
    if (date !== undefined) onPointClick?.(date)
  }, [days, onPointClick])

  const { host, style } = useChart(build, 170, onClick)
  return (
    <>
      <ChartFigure label={label} host={host} style={style}
        table={{
          columns: [t('charts.columns.date'), t('charts.columns.minimum'), t('charts.columns.mean'), t('charts.columns.maximum'), t('charts.columns.note')],
          rows: days.map((d) => {
            const correctedEntry = corrected.find((c) => c.date === d.date)
            return [
              d.date,
              d.hrMin ?? t('charts.absence.noReading'), d.hrMean ?? t('charts.absence.noReading'), d.hrMax ?? t('charts.absence.noReading'),
              [!d.worn ? t('charts.absence.notWorn') : '', excluded.includes(d.date) ? t('charts.absence.excluded') : '',
                correctedEntry ? t('charts.absence.correctedTo', { value: correctedEntry.value }) : '',
                annotations.find((a) => a.date === d.date)?.text ?? ''].filter(Boolean).join(', '),
            ]
          }),
        }} />
      {/* The band itself is drawn on the chart's canvas (markArea above), which a test cannot
          query. This is a deliberate, invisible seam so a test can assert the band's presence
          without depending on echarts' internal structure or on D1's token classes, which are
          free to change. */}
      {baseline && <span data-baseline-band aria-hidden="true" style={{ display: 'none' }} />}
    </>
  )
}
