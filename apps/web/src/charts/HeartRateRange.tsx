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
            //
            // xAxis is the day's own array position (findIndex), never `date.slice(8)`: the axis
            // itself is still labelled by day-of-month for display (below), but a category axis's
            // markPoint/markLine `xAxis` resolves a string against that label by name, and the
            // label repeats the moment a range crosses a month boundary (3months, year both draw
            // one point per calendar day with no downsampling). A string key placed the mark on the
            // FIRST day carrying that label rather than the day the override actually named,
            // silently swapping months; an index cannot collide, the same reason Sparkline's own
            // markPoint has always used `labels.indexOf(date)` rather than the label itself.
            data: [
              ...excluded.flatMap((date) => {
                const i = days.findIndex((d) => d.date === date)
                if (i === -1 || days[i]!.hrMean === null) return []
                return [{ name: 'excluded', xAxis: i, yAxis: days[i]!.hrMean }]
              }),
              ...corrected.flatMap((c) => {
                const i = days.findIndex((d) => d.date === c.date)
                if (i === -1 || days[i]!.hrMean === null) return []
                return [{ name: 'corrected', symbol: 'rect', symbolSize: SYMBOL.corrected,
                  itemStyle: { color: tokens.seriesAlt }, xAxis: i, yAxis: days[i]!.hrMean }]
              }),
            ] },
          markLine: { symbol: 'circle', lineStyle: { color: tokens.stageAwake, type: 'dashed' as const },
            label: { color: tokens.stageAwake, fontSize: base.axisLabel.fontSize, formatter: (p: { name: string }) => p.name },
            // Same index-not-label positioning as the markPoint above, and the same reason: a day
            // outside the visible range used to share its day-of-month label with a real day in
            // range and land on that day instead (chart-annotations.test.tsx's own regression case
            // for the single-month version of this; the two-month version, where a label repeats
            // inside one visible range rather than only across an excluded one, is the same defect
            // one filter short of catching, closed the same way here).
            data: annotations.flatMap((a) => {
              const i = days.findIndex((d) => d.date === a.date)
              return i === -1 ? [] : [{ name: a.text, xAxis: i }]
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
                // filter, not find: several annotations (an override reason, a note, an event) can
                // land on the same date now that day level marks join the per-metric ones, and a
                // single find() here would silently show only the first and drop the rest.
                annotations.filter((a) => a.date === d.date).map((a) => a.text).join(', ')].filter(Boolean).join(', '),
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
