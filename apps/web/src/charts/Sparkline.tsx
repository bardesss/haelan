import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, dayMarks, dayPointDate, dayTableRows, STROKE, OPACITY, SYMBOL } from './base.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatLocalDate, formatMetricValue } from '../format.js'
import { dayTooltip } from './dayTooltip.js'
import type { DayTooltipInput } from './dayTooltip.js'

// A stable reference for a caller that omits annotations/excluded, the same device Dashboard.tsx's
// own EMPTY constant uses: a default parameter expression that is a fresh `[]` literal runs on
// every call, handing `build`'s useCallback a new array identity on every render regardless of
// what actually changed, which is precisely the defect chart-lifecycle.test.tsx guards against.
const EMPTY = Object.freeze([]) as never[]

// No grid or ticks: a sparkline is a shape, not a chart to consult; the table carries the numbers it stands in for.
export function Sparkline({
  values, labels, label, unit, metric, formatValue, baseline, height = 34, annotations = EMPTY, excluded = EMPTY,
  onPointClick, episodic = false, trend,
}: {
  // Dense over the range the reader asked for, one entry per calendar day, with null where nothing
  // was reported: denseSeries (useSeries.ts) is what every caller builds them with, and its own
  // comment says why a points array straight off /series is not enough. A day with no position on
  // this axis cannot be marked, and an applied exclusion is exactly a day /series stops answering
  // for, so a sparse pair here silently loses the mark, the reason and the table row for the one
  // day the reader acted on.
  values: (number | null)[]
  labels: string[]
  label: string
  // The accessible table's second column header (already-translated display text, e.g. "steps"),
  // not a unit code: kept separate from `metric` below because a header string and a catalogue
  // lookup key answer two different questions and every caller already had the former on hand.
  unit: string
  // Every value in `values` is presumed to already be in METRICS[metric]'s own stored unit (see
  // formatMetricValue's doc comment in format.ts): the CHART never converts, since its y axis is
  // hidden (`show: false` below) and a linear rescale draws an identical shape regardless of unit.
  // The accessible TABLE is a different question, answered by `formatValue` below: this `metric`
  // prop alone drives the table's default formatting (`formatMetricValue(v, metric, ...)`), which
  // is right for every caller except one whose displayed unit differs from the stored one.
  //
  // Activity.tsx's own distance card used to be cited right here as proof no caller ever needed
  // that: an M3e review caught that it was not proof of correctness but the defect itself. Its
  // Sparkline plots the same per-day millimeter values as every other metric (harmless, per the
  // paragraph above), but its accessible table cell read those same raw millimeters
  // ("5,234,567") beside a column header translated as "Distance in kilometers" -- a sighted
  // reader saw a hand-converted "5.2 km" headline while a screen reader was handed a number seven
  // digits longer, under a header naming a unit that number was never in. `formatValue` below
  // exists so that one caller can override the table cell's own formatter without asking this
  // prop itself to claim a unit conversion the catalogue cannot answer for it.
  metric: string
  // Overrides the accessible table's own value-cell formatter (default: `formatMetricValue(v,
  // metric, language, absent)`), for the one shape formatMetricValue can never be handed safely:
  // a value already converted out of METRICS[metric]'s stored unit (format.ts's own comment on
  // formatNumber explains why formatMetricValue has no parameter for this). `values` above stay in
  // the stored unit regardless (the chart's own y axis is hidden, so nothing there needs a
  // conversion); this formatter runs per row against the same raw values, so it takes and converts
  // one value itself rather than being handed an already-converted array.
  formatValue?: (value: number | null, absent: string) => string
  // Optional and, when present, never thin: the same rule HeartRateRange's own `baseline` prop
  // documents. A band this project cannot stand behind reads as more authoritative than one built
  // from thirty real days, not less, so the caller (Recovery.tsx) only ever hands this over once
  // its own baseline query has cleared the thin check.
  baseline?: { low: number, high: number }
  height?: number
  // Same prop names and shapes HeartRateRange has taken since D1, so a page hands every chart type
  // the same annotations/excluded values instead of building a different shape per chart. Optional
  // here (HeartRateRange's own pair is required) because Sparkline's own default parameter (EMPTY,
  // below) has to exist regardless: a page can still mount a card before its overrides query has
  // answered.
  annotations?: { date: string; text: string }[]
  excluded?: string[]
  onPointClick?: (localDate: string) => void
  // Dense over the same `labels` axis as `values`, one entry per calendar day with null where the
  // trend has nothing to draw (packages/core/src/query/trend.ts's trendOf only emits a point for a
  // day carrying a real reading, so a day between two sparse readings is null here exactly as it is
  // in `values`). Undefined for every caller but Weight's weight card: PersonQuery.trend was
  // specced and built for that one card and had no consumer until this prop.
  //
  // Drawn as a second series rather than folded into `values`, and drawn UNDER it (first in the
  // `series` array below, so echarts paints it before the reading series and the readings land on
  // top): the smoothed line is a reading of the series, not the series itself, and Weight's own 130
  // readings across 236 days is exactly the sparse history a smooth line over would look identical
  // for a dense month and a sparse one if it replaced the readings instead of sitting under them.
  trend?: (number | null)[]
  // False everywhere but Weight: default false is what keeps every chart already on a page reading
  // exactly as it did before this prop existed. A metric taken by hand (weight: 130 readings across
  // 236 days) has no data quality problem on a day nobody weighed in, unlike Activity, Sleep or
  // Recovery, so this mode connects the line across the gap instead of breaking it and drops a
  // silent day (no value, not excluded, not annotated) from the accessible table rather than
  // rowing it as "no reading". A day the reader excluded or annotated keeps its row regardless: the
  // canvas still draws a markLine for it (the `marks.atDate` block below is untouched by this
  // prop), and a row-less table beside a mark that keeps asserting something would deny the one day
  // the reader actually acted on, table-only readers included.
  episodic?: boolean
}) {
  const { t, i18n } = useTranslation()

  // Memoised, and read by both `build` and `onClick`: `build` maps over these arrays to produce the
  // echarts entries, and a click on one of those entries indexes straight back into them, so the
  // two cannot disagree about which mark is which. Memoised for the reason `EMPTY` above exists as
  // well, since a fresh object here every render would rebuild `build` and dispose the chart.
  const marks = useMemo(() => dayMarks({
    dates: labels, values, excluded, annotations, excludedText: t('charts.absence.excluded'),
  }), [labels, values, excluded, annotations, t])

  // Whether there is a trend to draw, not merely whether a caller passed the prop. `trend` is a
  // dense array built from a query, so it is defined and all-null in three ordinary states: while
  // /trend is still in flight, after it failed, and when trendOf legitimately emitted nothing
  // because the range holds fewer than TREND_MIN_POINTS readings (packages/core/src/query/trend.ts).
  // Branching on `trend !== undefined` treated all three as "a trend line is on the chart" and
  // switched the readings to bare symbols with their own line hidden, so a two reading range, or a
  // /trend that 500ed, drew two disconnected dots under a smooth line that was never painted, with
  // nothing on the card saying why. With nothing to draw, this chart is exactly the chart every
  // other Sparkline caller gets.
  const hasTrend = trend !== undefined && trend.some((v) => v !== null)

  // One formatter, read by the canvas's tooltip and by every table row, rather than two built the
  // same way: `formatValue` is the override for a caller whose displayed unit differs from the
  // stored one (Activity's millimetres shown as kilometres, Weight's grams as kilograms), and a
  // tooltip that took the catalogue default while the table took the override would print two
  // different numbers for one day.
  const format = (value: number | null, absent: string): string =>
    formatValue ? formatValue(value, absent) : formatMetricValue(value, metric, i18n.language, absent)

  // A ref, not `build` dependencies, and for the reason useChart's own pointRef exists: the
  // tooltip reads `formatValue`, `t` and the language, and `formatValue` is a fresh arrow on every
  // render at two call sites (Activity.tsx's distance card, Weight.tsx's weight card). In `build`'s
  // dependency array those would dispose and re-initialise the chart on every render, which is the
  // exact defect chart-lifecycle.test.tsx guards. The formatter runs on hover, long after the
  // option was set, so reading the ref at that moment hands it the current values anyway.
  const tooltipRef = useRef<DayTooltipInput | null>(null)
  useLayoutEffect(() => {
    tooltipRef.current = {
      values, labels, excluded, annotations, marks, trend, hasTrend, episodic, unit, format, t,
    }
  })

  const build = useCallback((tokens: ChartTokens): EChartsOption => ({
    grid: { left: 0, right: 0, top: 4, bottom: 4 },
    tooltip: {
      ...chartBase(tokens).tooltip,
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
    xAxis: { type: 'category' as const, show: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value' as const, show: false, scale: true },
    series: [
      // Under the reading series below (drawn first, so echarts paints it first and the readings
      // land on top of it): trend's own dense array is null everywhere trendOf had no reading to
      // smooth, and connectNulls is unconditionally true here regardless of `episodic`, since a
      // smooth line spanning the gaps between sparse readings is the entire reason this series
      // exists, not a fact about whether the metric is taken by hand.
      ...(hasTrend ? [{ type: 'line' as const, data: trend, showSymbol: false, smooth: true,
        connectNulls: true, lineStyle: { width: STROKE.sparkline, color: tokens.seriesAlt } }] : []),
      { type: 'line' as const, data: values,
        // A trend line already supplies the connecting line once one is drawn, so the reading
        // series switches from a line to bare points: showSymbol true draws a marker at every
        // reading, and lineStyle opacity 0 (the same idiom IntradayHeartRate uses to hide a
        // stacking helper series) keeps its own jagged line from also being drawn under the smooth
        // one. Unchanged (a plain connected line, no symbols) when there is no trend line to draw,
        // which is every caller but Weight's weight card and, on that card, every range whose own
        // trend query has not answered with a real point (see hasTrend above).
        showSymbol: hasTrend, connectNulls: episodic,
        lineStyle: { width: STROKE.sparkline, color: tokens.series, ...(hasTrend && { opacity: 0 }) },
        // Same markArea shape HeartRateRange draws its band with: a rectangle between two y values,
        // unbounded on x, so it sits behind the line regardless of how many points there are.
        ...(baseline && { markArea: { silent: true, itemStyle: { color: tokens.band, opacity: OPACITY.baselineBand },
          data: [[{ yAxis: baseline.low }, { yAxis: baseline.high }]] } }),
        markPoint: { symbolSize: SYMBOL.excluded, itemStyle: { color: tokens.excluded },
          // markPoint's explicit coordinates skip axis extent calculation, so a placeholder y lands
          // off the fitted range; anchor at the day's own value instead, same as HeartRateRange.
          // dayMarks has already dropped a date this sparkline is not drawing and moved an excluded
          // day with no value left to `atDate`, where it is drawn by position instead of being
          // silently lost, so everything left here is a day whose number is still on the chart with
          // the mark sitting on top of it.
          data: marks.atValue.map((mark) => ({ name: 'excluded', xAxis: mark.index, yAxis: mark.value })) },
        markLine: { symbol: 'circle', lineStyle: { color: tokens.stageAwake, type: 'dashed' as const },
          label: { show: false },
          // An excluded day with no value left overrides the dashed annotation styling with the
          // excluded colour and a solid line, so a gap the reader made reads apart from a day that
          // merely carries a note, in shape as well as in colour. No label either way: this chart is
          // 34 pixels tall and draws no text at all, so the reason lives in the accessible table
          // beside it and in the panel a click on this mark reopens.
          data: marks.atDate.map((mark) => ({ name: mark.text, xAxis: mark.index,
            ...(mark.excluded && { lineStyle: { color: tokens.excluded, type: 'solid' as const } }) })) } },
    ],
  }), [values, baseline, marks, episodic, trend, hasTrend])

  const onClick = useCallback((event: ECElementEvent) => {
    const date = dayPointDate(labels, marks, event)
    if (date !== undefined) onPointClick?.(date)
  }, [labels, marks, onPointClick])

  // The same resolver as onClick, so the annotate control below the breakpoint names exactly the
  // point a click would have opened. This chart draws no axis labels at all, so the formatted date
  // is the only place the tapped day is ever written down outside the tooltip.
  const describe = useCallback((event: ECElementEvent) => {
    const date = dayPointDate(labels, marks, event)
    return date === undefined ? undefined : formatLocalDate(date, i18n.language)
  }, [labels, marks, i18n.language])

  const { host, style, tap } = useChart(build, height, { onClick, describe })
  return (
    <>
      <ChartFigure label={label} host={host} style={style} tap={tap}
        table={{
          // The trend gets a column of its own whenever it is drawn, between the reading and the
          // note. Without one, the smooth line existed only on the canvas: a table-only reader was
          // handed the raw readings and nothing at all of the line drawn through them, which is the
          // same canvas-and-table split the band toggle one card away was built to close. Absent
          // (and only then) the columns are exactly what every other caller has always had, so no
          // chart without a trend grows an empty column.
          columns: hasTrend
            ? [t('charts.columns.date'), unit, t('charts.columns.trend'), t('charts.columns.note')]
            : [t('charts.columns.date'), unit, t('charts.columns.note')],
          // dayTableRows (base.ts): shared with DailyBars' own accessible table, which needs
          // neither the trend column nor the episodic filter, so both default off there.
          rows: dayTableRows({ values, labels, excluded, annotations, format, t, episodic, trend, hasTrend }),
        }} />
      {/* The band itself is drawn on the chart's canvas (markArea above), which a test cannot
          query. Same deliberate, invisible seam as HeartRateRange's own sentinel, so a test can
          assert the band's presence without depending on echarts' internal structure. */}
      {baseline && <span data-baseline-band aria-hidden="true" style={{ display: 'none' }} />}
    </>
  )
}
