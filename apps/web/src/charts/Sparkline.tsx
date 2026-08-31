import { useCallback, useMemo } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { ANNOTATION_JOIN, dayMarks, markClickDate, STROKE, OPACITY, SYMBOL } from './base.js'
import type { DayMarks } from './base.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'

/**
 * Which local date a click on this sparkline landed on: a click on the line reads `labels` by the
 * series' own dataIndex, and a click on one of the overlay marks reads the mark it actually hit
 * (markClickDate in base.ts says why an overlay cannot be resolved against `labels`). Undefined
 * for a click that hit neither, which is empty space.
 *
 * An overlay click used to resolve to nothing at all. That was right while every mark sat on a
 * plotted point, since the click fell through to the point beneath it; an excluded day has no
 * point beneath it once the exclusion applies, and the mark is then the only thing there is to
 * click to undo it.
 *
 * A plain function, exported and tested on its own: echarts renders to an SVG this project's own
 * render environment cannot hit-test (see chart-marks.test.tsx's own note), so the
 * translation from a click event to a date is the one piece of this behaviour a test can reach.
 */
export function sparklinePointDate(
  labels: string[], marks: DayMarks, event: Pick<ECElementEvent, 'componentType' | 'dataIndex'>,
): string | undefined {
  if (event.componentType !== 'series') return markClickDate(marks, event)
  return labels[event.dataIndex]
}

// A stable reference for a caller that omits annotations/excluded, the same device Dashboard.tsx's
// own EMPTY constant uses: a default parameter expression that is a fresh `[]` literal runs on
// every call, handing `build`'s useCallback a new array identity on every render regardless of
// what actually changed, which is precisely the defect chart-lifecycle.test.tsx guards against.
const EMPTY = Object.freeze([]) as never[]

// No grid or ticks: a sparkline is a shape, not a chart to consult; the table carries the numbers it stands in for.
export function Sparkline({ values, labels, label, unit, baseline, height = 34, annotations = EMPTY, excluded = EMPTY, onPointClick }: {
  // Dense over the range the reader asked for, one entry per calendar day, with null where nothing
  // was reported: denseSeries (useSeries.ts) is what every caller builds them with, and its own
  // comment says why a points array straight off /series is not enough. A day with no position on
  // this axis cannot be marked, and an applied exclusion is exactly a day /series stops answering
  // for, so a sparse pair here silently loses the mark, the reason and the table row for the one
  // day the reader acted on.
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
  // the same annotations/excluded values instead of building a different shape per chart. Optional
  // here (HeartRateRange's own pair is required) because Sparkline's own default parameter (EMPTY,
  // below) has to exist regardless: a page can still mount a card before its overrides query has
  // answered.
  annotations?: { date: string; text: string }[]
  excluded?: string[]
  onPointClick?: (localDate: string) => void
}) {
  const { t } = useTranslation()

  // Memoised, and read by both `build` and `onClick`: `build` maps over these arrays to produce the
  // echarts entries, and a click on one of those entries indexes straight back into them, so the
  // two cannot disagree about which mark is which. Memoised for the reason `EMPTY` above exists as
  // well, since a fresh object here every render would rebuild `build` and dispose the chart.
  const marks = useMemo(() => dayMarks({
    dates: labels, values, excluded, annotations, excludedText: t('charts.absence.excluded'),
  }), [labels, values, excluded, annotations, t])

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
          ...(mark.excluded && { lineStyle: { color: tokens.excluded, type: 'solid' as const } }) })) } }],
  }), [values, baseline, marks])

  const onClick = useCallback((event: ECElementEvent) => {
    const date = sparklinePointDate(labels, marks, event)
    if (date !== undefined) onPointClick?.(date)
  }, [labels, marks, onPointClick])

  const { host, style } = useChart(build, height, onClick)
  return (
    <>
      <ChartFigure label={label} host={host} style={style}
        table={{
          columns: [t('charts.columns.date'), unit, t('charts.columns.note')],
          rows: values.map((v, i) => {
            const date = labels[i] ?? String(i)
            const isExcluded = excluded.includes(date)
            // "excluded", not "no reading", for a day the reader threw out: there was a reading,
            // and the day is blank because of something they did rather than because the device
            // never reported. "no reading" is the honest cell only for the second of those.
            return [date, v ?? t(isExcluded ? 'charts.absence.excluded' : 'charts.absence.noReading'),
              [isExcluded ? t('charts.absence.excluded') : '',
                // filter, not find: several annotations (an override reason, a note, an event) can
                // land on the same date now that day level marks join the per-metric ones, and a
                // single find() here would silently show only the first and drop the rest.
                // ANNOTATION_JOIN, not a second ', ' literal: annotationsByDate (base.ts) reads the
                // same constant, so a table cell and a canvas label built from the same annotations
                // array cannot drift apart on separator alone.
                annotations.filter((a) => a.date === date).map((a) => a.text).join(ANNOTATION_JOIN)]
                .filter(Boolean).join(ANNOTATION_JOIN)]
          }),
        }} />
      {/* The band itself is drawn on the chart's canvas (markArea above), which a test cannot
          query. Same deliberate, invisible seam as HeartRateRange's own sentinel, so a test can
          assert the band's presence without depending on echarts' internal structure. */}
      {baseline && <span data-baseline-band aria-hidden="true" style={{ display: 'none' }} />}
    </>
  )
}
