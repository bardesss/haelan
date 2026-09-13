import { useCallback, useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, dayMarks, dayTableRows } from './base.js'
import { scaleStops } from './tokens.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatMetricValue } from '../format.js'
import { barLabelInterval, barDateLabels } from './barAxis.js'
import { dayTooltip } from './dayTooltip.js'

// Same stable-identity idiom DailyBars' own EMPTY carries: a frozen array literal built once,
// rather than a fresh `[]` on every call, so passing it to the day-indexed helpers below never
// hands them a new array identity on every render (dayMarks/dayTableRows/dayTooltip all read
// `excluded`/`annotations` as dependencies elsewhere in this file's model, DailyBars.tsx).
const EMPTY = Object.freeze([]) as never[]

// One id for every series drawn by this chart: what makes echarts add the bars into one column
// rather than draw them overlapping. Not exposed to a caller -- every StackedDailyBars stacks,
// there is no unstacked mode -- so a fixed literal is enough; ZoneBar's own 'zones' is the same
// idiom for its own single stacked bar.
const STACK_ID = 'bands'

/** One band of a stacked day: `key` identifies it for a caller (a metric id, typically); `name` is
 *  its accessible label (the legend, the table column header, the tooltip line); `values` is dense
 *  over `labels` the same way DailyBars' own `values` prop is -- one entry per calendar day, null
 *  where nothing was reported. */
export interface BandSeries { key: string, name: string, values: (number | null)[] }

// A negative band is not a reading: it is the visible signature of the consuming page's own
// subtraction going wrong (an activity-band value computed as one running total minus the bands
// above it, going below zero when a later, more specific total exceeds an earlier, coarser one).
// Drawing it below the axis would render that defect as though it were data a reader should trust,
// so it is clamped here, at the one seam every band's values cross on the way into this chart,
// rather than by the series data, the table and the tooltip each clamping their own copy.
//
// A null is left alone: it is a day nothing reported, and DailyBars' own `values` prop carries the
// same distinction for the same reason (its own doc comment on that prop) -- a gap and a zero are
// different facts, and a day this page cannot answer for is not the same day as one whose answer
// was zero.
function clampBand(values: readonly (number | null)[]): (number | null)[] {
  return values.map((value) => (value === null ? null : Math.max(0, value)))
}

/**
 * DailyBars' stacked sibling: the same axis treatment, the same accessible table shape, the same
 * `ChartFigure` wrapper and `useChart` hook, but N series sharing one stack instead of one, so a
 * day's bands add into a single column rather than each drawing its own bar.
 *
 * No `excluded`/`annotations`/`onPointClick` props, unlike DailyBars: nothing upstream of this
 * chart's one caller (the Activity page's derived bands) has an override or a click target to offer
 * it yet, so `dayMarks` is always called with both empty and always returns an empty `DayMarks` --
 * kept anyway, rather than inlined as `{ atValue: [], atDate: [] }`, so this stays the same shape as
 * every other day-indexed chart and a later caller that does gain one need only thread it through,
 * not invent the wiring.
 */
export function StackedDailyBars({
  series, labels, label, unit, axisUnit, metric, height = 130,
}: {
  series: readonly BandSeries[]
  labels: string[]
  label: string
  /** Appended to each band's own name for the accessible table's column headers ("Light (Minutes)"),
   *  the same value-unit DailyBars' prop of this name carries for its own single column. */
  unit: string
  axisUnit: string
  // Every band is presumed already in METRICS[metric]'s own stored unit, same as DailyBars' own
  // `metric` prop: this chart never converts.
  metric: string
  height?: number
}) {
  const { t, i18n } = useTranslation()

  // Clamped once, at the boundary, and read by the series data, the table and the tooltip alike:
  // see clampBand's own comment for why a negative band is clamped rather than drawn, and why that
  // has to happen in exactly one place.
  const clamped = useMemo(
    () => series.map((band) => ({ ...band, values: clampBand(band.values) })),
    [series],
  )

  // Derived only from `metric` and the active language, unlike DailyBars' own `format`: this chart
  // takes no caller-supplied `formatValue`, so there is no fresh-closure-every-render identity to
  // guard `build`'s memoisation against and no need for DailyBars' own tooltipRef/axisLabel-ref
  // indirection -- `metric` and `i18n.language` are already in `build`'s own dependency list below.
  const format = (value: number | null, absent: string): string =>
    formatMetricValue(value, metric, i18n.language, absent)

  // Empty in practice (see this component's own doc comment above), computed the same way every
  // other day-indexed chart computes it rather than hardcoded, so a caller that gains excluded days
  // or annotations later only has to pass them through rather than invent this wiring from scratch.
  const marks = useMemo(
    () => dayMarks({ dates: labels, values: EMPTY, excluded: EMPTY, annotations: EMPTY, excludedText: t('charts.absence.excluded') }),
    [labels, t],
  )

  const build = useCallback((tokens: ChartTokens): EChartsOption => {
    const base = chartBase(tokens)
    const stops = scaleStops(tokens)
    return {
      grid: base.grid({ left: 44, right: 12, top: 12, bottom: 24 }),
      tooltip: {
        ...base.tooltip,
        trigger: 'axis' as const,
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params : [params]
          const index = (list[0] as { dataIndex?: number } | undefined)?.dataIndex
          if (index === undefined) return ''
          // Each band's own line comes from `dayTooltip`, the same day-readout formatter every
          // other day-indexed chart uses, called once per band with that band's own values and
          // name standing in for its `unit` label -- so a line here reads exactly like DailyBars'
          // own single tooltip line would for that band, escaped and translated the same way. Its
          // result is `"<escaped date><br/><escaped line>"` (no trend, no mark), so the date --
          // identical across every band, since they all share one `labels` -- is split off and
          // kept from the first band only, and every band contributes just its own line.
          const parts = clamped.map((band) => {
            const full = dayTooltip(
              { values: band.values, labels, excluded: EMPTY, annotations: EMPTY, marks, trend: undefined,
                hasTrend: false, episodic: false, unit: band.name, format, t },
              { componentType: 'series', dataIndex: index },
            )
            const sep = full.indexOf('<br/>')
            return sep === -1 ? [full, ''] as const : [full.slice(0, sep), full.slice(sep + '<br/>'.length)] as const
          })
          if (parts.length === 0) return ''
          return [parts[0]![0], ...parts.map(([, line]) => line)].join('<br/>')
        },
      },
      xAxis: {
        type: 'category' as const,
        data: barDateLabels(labels),
        ...base.labelledAxis,
        axisLabel: { ...base.axisLabel, interval: barLabelInterval(labels.length) },
      },
      yAxis: {
        type: 'value' as const,
        // Zero, always: a stacked bar's length is its value the same way a plain one is, so an
        // axis that does not start at zero misstates every band's share of the column, not only the
        // total's ratio between two days DailyBars' own comment on this same line describes.
        min: 0,
        name: axisUnit,
        nameTextStyle: { color: base.axisLabel.color, fontSize: base.axisLabel.fontSize },
        splitLine: base.splitLine,
        axisLabel: { ...base.axisLabel, formatter: (value: number) => format(value, '') },
      },
      series: clamped.map((band, index) => ({
        type: 'bar' as const,
        // One shared id: what makes these bars add rather than overlap. See STACK_ID's own comment.
        stack: STACK_ID,
        name: band.name,
        data: band.values,
        itemStyle: { color: stops[index % stops.length] },
      })),
    }
  }, [clamped, labels, axisUnit, metric, i18n.language, marks, t])

  const { host, style } = useChart(build, height)

  return (
    <ChartFigure label={label} host={host} style={style}
      table={{
        columns: [t('charts.columns.date'), ...clamped.map((band) => `${band.name} (${unit})`)],
        // dayTableRows (base.ts) called once per band, each producing `[date, cell, note]` with
        // nothing this chart draws into the note column (no excluded days, no annotations -- see
        // this component's own doc comment on why), then reassembled into one row per date with one
        // value column per band. The shape `dayTableRows` itself produces is DailyBars' own
        // single-value-column one; the extension to N columns has to happen here, at the one caller
        // that actually needs it, rather than inside a helper every other day-indexed chart also
        // calls with a single value column of its own.
        rows: labels.map((date, i) => [
          date,
          ...clamped.map((band) =>
            dayTableRows({ values: band.values, labels, excluded: EMPTY, annotations: EMPTY, format, t })[i]![1]!),
        ]),
      }} />
  )
}
