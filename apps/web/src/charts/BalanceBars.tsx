import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, dayMarks, dayPointDate, dayTableRows, SYMBOL } from './base.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatLocalDate, formatSignedDuration } from '../format.js'
import { barLabelInterval, barDateLabels } from './barAxis.js'
import { dayTooltip } from './dayTooltip.js'
import type { DayTooltipInput } from './dayTooltip.js'

// A stable reference for a caller that omits annotations/excluded, the same device DailyBars' own
// EMPTY constant is: a default parameter expression that is a fresh `[]` literal runs on every
// call, handing `build`'s useCallback a new array identity on every render regardless of what
// actually changed, which is precisely the defect chart-lifecycle.test.tsx guards against.
const EMPTY = Object.freeze([]) as never[]

// The zero line's own dashed mark, the same shape DailyBars gives its annotation line. A constant
// rather than an object literal built inside `build`, for the same reason EMPTY is one: `build`
// closes over it, so a fresh object here would be a fresh dependency on every render.
const ZERO_LINE_NAME = 'zero'

/**
 * The sleep balance card's chart: one bar per night, drawn as its signed deviation from a zero
 * line rather than as a value measured from the axis floor.
 *
 * A separate component from DailyBars, not a flag on it, and the difference is the axis contract
 * rather than a preference. DailyBars starts its value axis at zero deliberately, because a bar's
 * LENGTH is its value there and a truncated axis would misstate the ratio between two days; that
 * is the whole reason it carries `min: 0` and a comment saying so. This chart's bars are
 * deviations, half of them negative by construction, and clamping them to a floor at zero would
 * draw a night two hours under its target as a bar of length zero. So the extent here is symmetric
 * around zero and the zero line is drawn as a dashed markLine instead, which is the thing that
 * carries "this is where the comparison sits" in the axis's absence.
 *
 * What it does NOT change is the accessible table, the marks or the click resolution: all three go
 * through the same shared helpers DailyBars uses (dayTableRows, dayMarks, dayPointDate), because a
 * canvas and a table that disagree about a day are the defect this project treats as binding.
 */
export function BalanceBars({
  values, labels, label, unit, formatValue,
  height = 130, annotations = EMPTY, excluded = EMPTY, onPointClick,
}: {
  // Dense over the range the reader asked for, one entry per calendar day, with null where nothing
  // was reported: see DailyBars' own comment on this same prop for why a sparse pair is not enough
  // (a day with no position on this axis cannot be marked). A null draws no bar at all, which is
  // the point rather than an empty one: absent is never a zero here, because a night with no
  // reading is not a night of exactly zero surplus.
  values: (number | null)[]
  labels: string[]
  label: string
  /** The accessible table's value-column header, as DailyBars' prop of this name. */
  unit: string
  // Every value in `values` is presumed to be minutes of deviation from the zero line. Optional,
  // and defaulted to formatSignedDuration below, because this is the only chart in the app whose
  // values are inherently signed and the shared duration formatter is the one thing that prints a
  // negative one without two minus signs.
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
  // several built the same way. Unlike DailyBars this falls back to formatSignedDuration rather
  // than to the metric catalogue: there is no metric behind these numbers, they are a subtraction
  // the caller performed, and formatMetricValue would need a metric name that does not exist.
  const format = (value: number | null, absent: string): string =>
    formatValue ? formatValue(value, absent) : formatSignedDuration(value, absent)

  // A ref, not `build` dependencies: `formatValue` is a fresh arrow at any call site that passes
  // one, and folding it into `build`'s dependency array would dispose and reinitialise the chart
  // on every render, the exact defect chart-lifecycle.test.tsx guards. `format` itself depends on
  // `i18n.language` through formatSignedDuration's own Intl calls, which is the same reason.
  const tooltipRef = useRef<DayTooltipInput | null>(null)
  useLayoutEffect(() => {
    tooltipRef.current = {
      values, labels, excluded, annotations, marks, trend: undefined, hasTrend: false, episodic: false,
      unit, format, t,
    }
  })

  // The half extent of the value axis, in minutes, always symmetric around the zero line
  // even when one side holds nothing: the line is the comparison every bar is measured against,
  // so it sits in the middle of the card rather than wherever the data's own extent happened to
  // fall. A range of only surplus nights still draws the line mid plot with empty space below
  // it, and that space is the point rather than waste: it is what says no night fell short.
  //
  // Rounded up to the next half hour with an hour as the floor, because the extent produces
  // exactly three ticks (splitNumber below): the minimum, zero, the maximum. A fitted extent
  // would label five or more deviations the reader never asked to compare, and an unfitted one
  // ticks at whatever the data's own extremes happen to be ("-1h 47m"), a precision the
  // comparison does not have. Plain numbers, memoised off the same `values` array the chart is
  // drawn from, so `build`'s dependency chain stays primitive (chart-lifecycle.test.tsx).
  const extent = useMemo(() => {
    let peak = 0
    for (const value of values) {
      if (typeof value === 'number') peak = Math.max(peak, Math.abs(value))
    }
    return Math.max(60, Math.ceil(peak / 30) * 30)
  }, [values])

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
        // Dates, not array positions, for DailyBars' own reason: this axis is labelled, so what it
        // carries is what a reader reads. barDateLabels switches to MM-DD once the range crosses a
        // second calendar month, so a quarter or a year does not repeat the same handful of
        // day-of-month numbers with nothing to tell them apart.
        data: barDateLabels(labels),
        ...base.labelledAxis,
        axisLabel: { ...base.axisLabel, interval: barLabelInterval(labels.length) },
      },
      yAxis: {
        type: 'value' as const,
        // No `min: 0`. This is the deliberate difference from DailyBars and the reason this is a
        // second component: half of these bars are negative by construction, and a floor at zero
        // would silently flatten every deficit night to nothing.
        //
        // A fixed symmetric extent with exactly three ticks, rather than a fitted one: the zero
        // line is the only interior reference this chart needs, and the minimum and maximum name
        // the range's own extremes. echarts divides a fixed extent by splitNumber, so 2 puts the
        // ticks at -extent, zero and +extent however the data falls.
        min: -extent,
        max: extent,
        splitNumber: 2,
        splitLine: base.splitLine,
        // Through the ref, not the `format` closure above, for the same reason the tooltip
        // formatter reads it: `format` depends on `formatValue` and `i18n.language`, neither of
        // which is in `build`'s dependency array. Closing over `format` here would freeze the axis
        // on whichever formatter existed when `build` was last rebuilt while the tooltip and the
        // table stayed current, three channels the design says must never disagree.
        axisLabel: { ...base.axisLabel, formatter: (value: number) => tooltipRef.current?.format(value, '') ?? '' },
      },
      series: [{
        type: 'bar' as const,
        data: values,
        itemStyle: {
          // Read inside `build` rather than hoisted to a constant, which is the point: `build` runs
          // again on every token change (useChart keys its rebuild on this callback and on the
          // tokens it was handed), so a theme switch recolours the bars with no third mechanism.
          color: (params: { value?: unknown }) =>
            typeof params.value === 'number' && params.value < 0 ? tokens.balanceUnder : tokens.balanceOver,
        },
        // markPoint's explicit coordinates skip axis extent calculation, so a placeholder y lands
        // off the fitted range; anchor at the day's own value instead, same as DailyBars. dayMarks
        // has already dropped a date this chart is not drawing and moved an excluded day with no
        // value left to `atDate`, where it is drawn by position instead of being silently lost.
        markPoint: { symbolSize: SYMBOL.excluded, itemStyle: { color: tokens.excluded },
          data: marks.atValue.map((mark) => ({ name: 'excluded', xAxis: mark.index, yAxis: mark.value })) },
        markLine: {
          symbol: 'none',
          // The zero line and the annotation lines share this one markLine, which is why neither
          // carries a label: a labelled zero line would have to be disambiguated from an
          // annotation's own text at the same anchor, and the accessible table already states both
          // in words.
          lineStyle: { color: tokens.axis, type: 'dashed' as const },
          label: { show: false },
          data: [
            // An excluded day, drawn by position across the plot with no value left to sit on. Its
            // own solid styling overrides the dashed default so a gap the reader made reads apart
            // from a day that merely carries a note, in shape as well as in colour.
            ...marks.atDate.map((mark) => ({ name: mark.text, xAxis: mark.index,
              ...(mark.excluded && { lineStyle: { color: tokens.excluded, type: 'solid' as const } }) })),
            // The zero line itself, in the axis colour: it is structure rather than a mark to read
            // a value off, exactly as the gridlines are. Drawn as a markLine rather than as one
            // more yAxis tick because it has to sit at the comparison point, and echarts places
            // ticks wherever the extent it fitted happens to put them.
            //
            // It rides in the same array as the annotations and therefore counts into the
            // markLine's own dataIndex, which is why `markClickDate` (base.ts) bottoms out in an
            // optional lookup: last in this array, its index sits past the end of marks.atDate,
            // so a click on this entry resolves to no date rather than to the first annotation,
            // and dayPointDate discards it. Splitting the two into separate markLine objects
            // would keep two sets of indices, which is the drift base.ts's own DayMarks doc
            // comment exists to make impossible.
            { name: ZERO_LINE_NAME, yAxis: 0, lineStyle: { color: tokens.axis, type: 'dashed' as const } },
          ],
        },
      }],
    }
  }, [values, labels, marks, extent])

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

  // Conditional on the caller having somewhere to send a click, not unconditional: `onClick` above
  // bottoms out in `onPointClick?.(...)`, so handing useChart a pair it can never act on renders an
  // annotate control that names a point and then does nothing when pressed. See useChart's
  // ChartPointHandlers doc comment; chart-annotate-handlers.test.tsx pins it.
  const { host, style, tap } = useChart(build, height, onPointClick ? { onClick, describe } : undefined)
  return (
    <ChartFigure label={label} host={host} style={style} tap={tap}
      table={{
        columns: [t('charts.columns.date'), unit, t('charts.columns.note')],
        rows: dayTableRows({ values, labels, excluded, annotations, format, t }),
      }} />
  )
}
