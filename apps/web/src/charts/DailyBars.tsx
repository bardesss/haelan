import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, dayMarks, dayPointDate, dayTableRows, SYMBOL } from './base.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatLocalDate, formatMetricValue } from '../format.js'
import { barLabelInterval, barDateLabels } from './barAxis.js'
import { dayTooltip } from './dayTooltip.js'
import type { DayTooltipInput } from './dayTooltip.js'

// A stable reference for a caller that omits annotations/excluded, the same device Sparkline's own
// EMPTY constant is: a default parameter expression that is a fresh `[]` literal runs on every
// call, handing `build`'s useCallback a new array identity on every render regardless of what
// actually changed, which is precisely the defect chart-lifecycle.test.tsx guards against.
const EMPTY = Object.freeze([]) as never[]

// A labelled daily bar chart: unlike Sparkline, both axes are shown and the value axis always
// starts at zero, because a bar's length IS its value and a truncated axis misstates the ratio
// between two days.
export function DailyBars({
  values, labels, label, unit, axisUnit, metric, formatValue, minInterval,
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
  // The smallest step the caller's own `formatValue` can tell apart, wired straight to echarts'
  // `yAxis.minInterval`. Optional, and left to the caller rather than derived here from
  // `METRICS[metric].precision`: echarts picks tick steps off the STORED scale, but the axis
  // label runs the DISPLAY formatter, and nothing stops a tick step finer than that formatter can
  // resolve -- floors at a small range ticks at 0/0.5/1 and the shared formatter, which has no
  // fractional floor to show, prints "0 | 0 | 0 | 1 | 1 | 1", three gridlines all labelled zero.
  // The catalogue's own precision cannot fix this from inside the chart: distance is stored in
  // millimetres at precision 0, so that reasoning would hand a millimetre-scale minInterval to the
  // one metric whose kilometre formatter (one decimal) needs none. Only the caller, who wrote the
  // formatter, knows what it can resolve; Activity.tsx passes 1 for floors and leaves this unset
  // for distance.
  minInterval?: number
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
  // pointRef for why. `formatValue` is a fresh arrow on every render at both of this component's
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
        // barDateLabels switches to MM-DD once the range crosses into a second calendar month, so
        // a quarter or a year of labels does not repeat the same handful of day-of-month numbers
        // with nothing to tell them apart (barAxis.ts's own doc comment has the measurements).
        data: barDateLabels(labels),
        ...base.labelledAxis,
        axisLabel: { ...base.axisLabel, interval: barLabelInterval(labels.length) },
      },
      yAxis: {
        type: 'value' as const,
        // Zero, always. See the test, and section 3 of the design.
        min: 0,
        // The smallest step the caller's own formatter can resolve (see the `minInterval` prop's
        // own comment): left undefined for a caller that does not pass one, which is what
        // `yAxis.minInterval` already does when omitted.
        minInterval,
        name: axisUnit,
        nameTextStyle: { color: base.axisLabel.color, fontSize: base.axisLabel.fontSize },
        splitLine: base.splitLine,
        // Through the ref, not the `format` closure above, for the same reason the tooltip
        // formatter reads it: `format` depends on `formatValue` (a fresh arrow every render at
        // both of this component's call sites) and `i18n.language`, neither of which is in
        // `build`'s dependency array. Closing over `format` here would freeze the axis on
        // whichever formatter existed when `build` was last rebuilt while the tooltip and the
        // table stayed current, three channels the design says must never disagree.
        axisLabel: { ...base.axisLabel, formatter: (value: number) => tooltipRef.current?.format(value, '') ?? '' },
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
  }, [values, labels, marks, axisUnit, minInterval])

  const onClick = useCallback((event: ECElementEvent) => {
    const date = dayPointDate(labels, marks, event)
    if (date !== undefined) onPointClick?.(date)
  }, [labels, marks, onPointClick])

  // The same resolver as onClick, so the annotate control below the breakpoint names exactly the
  // point a click would have opened. The full date rather than the axis label beside it: the axis
  // thins its labels out (barLabelInterval), so a bar can be tapped that has no label at all.
  const describe = useCallback((event: ECElementEvent) => {
    const date = dayPointDate(labels, marks, event)
    return date === undefined ? undefined : formatLocalDate(date, i18n.language)
  }, [labels, marks, i18n.language])

  const { host, style, tap } = useChart(build, height, { onClick, describe })
  return (
    <ChartFigure label={label} host={host} style={style} tap={tap}
      table={{
        columns: [t('charts.columns.date'), unit, t('charts.columns.note')],
        // dayTableRows (base.ts): the row builder Sparkline's own accessible table uses, without
        // its trend column and episodic filtering, neither of which this chart draws.
        rows: dayTableRows({ values, labels, excluded, annotations, format, t }),
      }} />
  )
}
