import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { ANNOTATION_JOIN, chartBase, dayMarks, markClickDate, SYMBOL } from './base.js'
import type { DayMarks } from './base.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatMetricValue } from '../format.js'
import { barLabelInterval } from './barAxis.js'
import { dayTooltip } from './dayTooltip.js'
import type { DayTooltipInput } from './dayTooltip.js'

/**
 * Which local date a click on this bar chart landed on: a click on a bar reads `labels` by the
 * series' own dataIndex, and a click on one of the overlay marks reads the mark it actually hit
 * (markClickDate in base.ts says why an overlay cannot be resolved against `labels`). Undefined
 * for a click that hit neither, which is empty space. Same shape as Sparkline's own
 * `sparklinePointDate`, and for the identical reason: a plain function, exported and tested on its
 * own, because echarts renders to an SVG this project's render environment cannot hit-test.
 */
export function dailyBarsPointDate(
  labels: string[], marks: DayMarks, event: Pick<ECElementEvent, 'componentType' | 'dataIndex'>,
): string | undefined {
  if (event.componentType !== 'series') return markClickDate(marks, event)
  return labels[event.dataIndex]
}

// A stable reference for a caller that omits annotations/excluded, the same device Sparkline's own
// EMPTY constant is: a default parameter expression that is a fresh `[]` literal runs on every
// call, handing `build`'s useCallback a new array identity on every render regardless of what
// actually changed, which is precisely the defect chart-lifecycle.test.tsx guards against.
const EMPTY = Object.freeze([]) as never[]

// A labelled daily bar chart: unlike Sparkline, both axes are shown and the value axis always
// starts at zero, because a bar's length IS its value and a truncated axis misstates the ratio
// between two days.
export function DailyBars({
  values, labels, label, unit, axisUnit, metric, formatValue,
  height = 130, annotations = EMPTY, excluded = EMPTY, onPointClick,
}: {
  // Dense over the range the reader asked for, one entry per calendar day, with null where nothing
  // was reported: see Sparkline's own comment on this same prop for why a sparse pair is not
  // enough (a day with no position on this axis cannot be marked).
  values: (number | null)[]
  labels: string[]
  label: string
  /** The accessible table's value-column header, as Sparkline's prop of this name. */
  unit: string
  /** The short unit for the value axis's own name ("km", "floors"), from the page's shortUnitKey. */
  axisUnit: string
  // Every value in `values` is presumed to already be in METRICS[metric]'s own stored unit; this
  // chart never converts (see Sparkline's own comment on this prop). The axis label formatter
  // below runs the caller's own `formatValue` for that reason.
  metric: string
  formatValue?: (value: number | null, absent: string) => string
  height?: number
  annotations?: { date: string; text: string }[]
  excluded?: string[]
  onPointClick?: (localDate: string) => void
}) {
  const { t, i18n } = useTranslation()

  // Memoised, and read by both `build` and `onClick`: see Sparkline's own comment on this value for
  // why the two cannot be built from separately-assembled lists.
  const marks = useMemo(() => dayMarks({
    dates: labels, values, excluded, annotations, excludedText: t('charts.absence.excluded'),
  }), [labels, values, excluded, annotations, t])

  // One formatter, read by the canvas's tooltip, the value axis and every table row, rather than
  // several built the same way: see Sparkline's own comment on this value for why a tooltip or
  // axis that took the catalogue default while the table took the override would disagree.
  const format = (value: number | null, absent: string): string =>
    formatValue ? formatValue(value, absent) : formatMetricValue(value, metric, i18n.language, absent)

  // A ref, not `build` dependencies: see Sparkline's own tooltipRef comment and useChart's own
  // onClickRef for why. `formatValue` is a fresh arrow on every render at both of this component's
  // call sites (Activity.tsx's distance and floors cards), and folding it into `build`'s dependency
  // array would dispose and re-initialise the chart on every render, the exact defect
  // chart-lifecycle.test.tsx guards.
  const tooltipRef = useRef<DayTooltipInput | null>(null)
  useLayoutEffect(() => {
    tooltipRef.current = {
      values, labels, excluded, annotations, marks, trend: undefined, hasTrend: false, episodic: false, unit, format, t,
    }
  })

  const build = useCallback((tokens: ChartTokens): EChartsOption => {
    const base = chartBase(tokens)
    return {
      grid: base.grid({ left: 44, right: 12, top: 12, bottom: 24 }),
      tooltip: {
        ...base.tooltip,
        trigger: 'axis' as const,
        // Every input arrives through the ref rather than through this closure, so nothing here
        // widens `build`'s dependency array; see tooltipRef above for why that matters.
        formatter: (params: unknown) => {
          const p = Array.isArray(params) ? params[0] : params
          const current = tooltipRef.current
          if (!p || !current) return ''
          return dayTooltip(current, p as Parameters<typeof dayTooltip>[1])
        },
      },
      xAxis: {
        type: 'category' as const,
        // Dates, not array positions: this axis is labelled, so what it carries is what a reader
        // reads. Sparkline can hand echarts indices precisely because its axis is hidden.
        data: labels.map((date) => date.slice(8)),
        ...base.labelledAxis,
        axisLabel: { ...base.axisLabel, interval: barLabelInterval(labels.length) },
      },
      yAxis: {
        type: 'value' as const,
        // Zero, always. See the test, and section 3 of the design.
        min: 0,
        name: axisUnit,
        nameTextStyle: { color: base.axisLabel.color, fontSize: base.axisLabel.fontSize },
        splitLine: base.splitLine,
        axisLabel: { ...base.axisLabel, formatter: (value: number) => format(value, '') },
      },
      series: [{
        type: 'bar' as const, data: values, itemStyle: { color: tokens.series },
        // markPoint's explicit coordinates skip axis extent calculation, so a placeholder y lands
        // off the fitted range; anchor at the day's own value instead, same as Sparkline.
        // dayMarks has already dropped a date this chart is not drawing and moved an excluded day
        // with no value left to `atDate`, where it is drawn by position instead of being silently
        // lost, so everything left here is a day whose number is still on the chart with the mark
        // sitting on top of it.
        markPoint: { symbolSize: SYMBOL.excluded, itemStyle: { color: tokens.excluded },
          data: marks.atValue.map((mark) => ({ name: 'excluded', xAxis: mark.index, yAxis: mark.value })) },
        markLine: { symbol: 'circle', lineStyle: { color: tokens.stageAwake, type: 'dashed' as const },
          label: { show: false },
          // An excluded day with no value left overrides the dashed annotation styling with the
          // excluded colour and a solid line, so a gap the reader made reads apart from a day that
          // merely carries a note, in shape as well as in colour. No label either way, same as
          // Sparkline: the reason lives in the accessible table beside it and in the panel a click
          // on this mark reopens.
          data: marks.atDate.map((mark) => ({ name: mark.text, xAxis: mark.index,
            ...(mark.excluded && { lineStyle: { color: tokens.excluded, type: 'solid' as const } }) })) },
      }],
    }
  }, [values, labels, marks, axisUnit])

  const onClick = useCallback((event: ECElementEvent) => {
    const date = dailyBarsPointDate(labels, marks, event)
    if (date !== undefined) onPointClick?.(date)
  }, [labels, marks, onPointClick])

  const { host, style } = useChart(build, height, onClick)
  return (
    <ChartFigure label={label} host={host} style={style}
      table={{
        columns: [t('charts.columns.date'), unit, t('charts.columns.note')],
        rows: values.map((v, i) => {
          const date = labels[i] ?? String(i)
          const isExcluded = excluded.includes(date)
          // "excluded", not "no reading", for a day the reader threw out: there was a reading, and
          // the day is blank because of something they did rather than because the device never
          // reported. "no reading" is the honest cell only for the second of those.
          const absent = t(isExcluded ? 'charts.absence.excluded' : 'charts.absence.noReading')
          const cell = format(v, absent)
          return [date, cell,
            [isExcluded ? t('charts.absence.excluded') : '',
              // filter, not find: several annotations can land on the same date now that day
              // level marks join the per-metric ones, and a single find() here would silently
              // show only the first and drop the rest. ANNOTATION_JOIN, not a second ', ' literal:
              // annotationsByDate (base.ts) reads the same constant, so a table cell and a canvas
              // label built from the same annotations array cannot drift apart on separator alone.
              annotations.filter((a) => a.date === date).map((a) => a.text).join(ANNOTATION_JOIN)]
              .filter(Boolean).join(ANNOTATION_JOIN)]
        }),
      }} />
  )
}
