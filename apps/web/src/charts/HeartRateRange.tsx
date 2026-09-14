import { useCallback, useMemo, useState } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { ANNOTATION_JOIN, chartBase, dayMarks, markClickDate, OPACITY, STROKE, SYMBOL, tip } from './base.js'
import type { DayMarks } from './base.js'
import type { ChartTokens } from './tokens.js'
import { hrTooltip } from './hrTooltip.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatLocalDate, formatMetricValue } from '../format.js'
import type { DayRow } from '../fixtures/july.js'

type Props = {
  days: DayRow[]
  // Optional and, when present, never thin: the call site only ever passes a baseline that
  // cleared useBaseline's own thin check, since a band this project cannot stand behind reads as
  // more authoritative than a band built from thirty real days, not less.
  baseline?: { low: number; high: number }
  annotations: { date: string; text: string }[]
  excluded: string[]
  label: string
  onPointClick?: (localDate: string) => void
}

/**
 * Which local date a click on this chart landed on: a click on one of the min/range/mean series
 * reads `days` by dataIndex, and a click on one of the overlay marks reads the mark it actually
 * hit. All three series share one category axis (`days`, by position), so `dataIndex` resolves to
 * the same day regardless of which of the three was clicked; an overlay's dataIndex counts into
 * its own data array instead, which is what markClickDate resolves against.
 *
 * An overlay click used to resolve to nothing, which was right while every mark sat on a plotted
 * day: the click fell through to the series underneath it. An excluded day has no mean, no min and
 * no max left once the exclusion applies, so nothing is drawn there for a click to fall through
 * to, and the mark is the only thing left to click to undo it.
 *
 * A plain function, exported and tested on its own, the same device base.ts's own
 * `dayPointDate` and ActivityHeatmap's own `heatmapClickDate` are: echarts renders to an SVG
 * this project's render environment cannot hit-test, so the translation from a click event to a
 * date is the one piece of this behaviour a test can reach. See chart-marks.test.tsx.
 */
export function heartRateRangePointDate(
  days: DayRow[], marks: DayMarks, event: Pick<ECElementEvent, 'componentType' | 'dataIndex'>,
): string | undefined {
  if (event.componentType !== 'series') return markClickDate(marks, event)
  return days[event.dataIndex]?.date
}

export function HeartRateRange({ days, baseline, annotations, excluded, label, onPointClick }: Props) {
  const { t, i18n } = useTranslation()

  // Section 11's own named example of a card level control: the min/max band is shown by default,
  // today's behaviour, and this is the one piece of state that decides both what the canvas draws
  // and what the accessible table lists, so the two cannot disagree about what is currently shown.
  // Component state, not localStorage: like the rail's own collapsed flag, this is a fact about
  // this view rather than about the reader, but unlike the rail nothing here asks it to survive a
  // navigation, so there is nothing to persist.
  const [showBand, setShowBand] = useState(true)

  // Memoised, and read by both `build` and `onClick`, for the reason DayMarks' own doc comment
  // gives: the echarts entries and the click lookup have to come off the one list or they can
  // disagree about which mark a dataIndex names.
  const marks = useMemo(() => dayMarks({
    dates: days.map((d) => d.date), values: days.map((d) => d.hrMean),
    excluded, annotations, excludedText: t('charts.absence.excluded'),
  }), [days, excluded, annotations, t])

  const build = useCallback((tokens: ChartTokens): EChartsOption => {
    const base = chartBase(tokens)
    return {
      grid: base.grid({ top: 18 }),
      tooltip: {
        ...base.tooltip,
        trigger: 'axis' as const,
        // A mark's own tooltip.trigger defaults to 'item' (MarkPointModel/MarkLineModel both set
        // it in their own defaultOption), which overrides this chart's 'axis' trigger above, so a
        // markPoint/markLine hover reaches this formatter as a single params object rather than
        // the array an axis hover passes. Its dataIndex counts into that mark's own data array
        // (marks.atValue / marks.atDate), never into `days`: `hrTooltip(days, dataIndex)` on that
        // number named whichever day happened to sit at that small index, wrong for every mark
        // not itself drawn on days[dataIndex] (the first mark included, whenever it sits on a
        // later day). Resolving through `marks` first, the same list `build` drew the marks from,
        // keeps the two from disagreeing.
        formatter: (params) => {
          const p = Array.isArray(params) ? params[0] : params
          if (!p) return ''
          if (p.componentType === 'markPoint') {
            const mark = marks.atValue[p.dataIndex]
            return mark ? tip`${mark.date}<br/>${t('charts.absence.excluded')}` : ''
          }
          if (p.componentType === 'markLine') {
            const mark = marks.atDate[p.dataIndex]
            return mark ? tip`${mark.date}<br/>${mark.text}` : ''
          }
          return hrTooltip(days, p.dataIndex, t, i18n.language)
        },
      },
      xAxis: { type: 'category' as const, data: days.map((d) => d.date.slice(8)), ...base.labelledAxis },
      yAxis: { type: 'value' as const, scale: true, splitLine: base.splitLine, axisLabel: base.axisLabel },
      series: [
        // 'min' carries no visible pixel of its own; its only job is to hold the stack's
        // invisible base so 'range' draws its area at the right height. Dropped together with
        // 'range' when the band is off, so no invisible series is left stacking under nothing.
        ...(showBand ? [
          { name: 'min', type: 'line' as const, data: days.map((d) => d.hrMin), showSymbol: false, connectNulls: false,
            lineStyle: { opacity: 0 }, stack: 'range', areaStyle: { opacity: 0 } },
          { name: 'range', type: 'line' as const, data: days.map((d) => (d.hrMax !== null && d.hrMin !== null ? d.hrMax - d.hrMin : null)),
            showSymbol: false, connectNulls: false, lineStyle: { opacity: 0 }, stack: 'range',
            areaStyle: { color: tokens.stageLight, opacity: OPACITY.rangeBand } },
        ] : []),
        { name: 'mean', type: 'line' as const, data: days.map((d) => d.hrMean), showSymbol: false, connectNulls: false,
          lineStyle: { width: STROKE.series, color: tokens.series },
          ...(baseline && { markArea: { silent: true, itemStyle: { color: tokens.band, opacity: OPACITY.baselineBand },
            data: [[{ yAxis: baseline.low }, { yAxis: baseline.high }]] } }),
          markPoint: { symbolSize: SYMBOL.excluded, itemStyle: { color: tokens.excluded },
            // markPoint's explicit coordinates skip axis extent calculation, so a placeholder y lands off the fitted range.
            // Anchor each marker at the day's actual mean instead. dayMarks has already moved an excluded day whose mean
            // is gone to `atDate`, where it is drawn by position and needs no y, rather than dropping it the way this
            // list built in place used to, so everything left here is a day whose mean is still drawn under its mark.
            //
            // xAxis is the day's own array position, never `date.slice(8)`: the axis itself is
            // still labelled by day-of-month for display (below), but a category axis's
            // markPoint/markLine `xAxis` resolves a string against that label by name, and the
            // label repeats the moment a range crosses a month boundary (3months, year both draw
            // one point per calendar day with no downsampling). A string key placed the mark on the
            // FIRST day carrying that label rather than the day the override actually named,
            // silently swapping months; an index cannot collide, which is why dayMarks resolves
            // every mark to an index before this chart ever sees it.
            data: marks.atValue.map((mark) => ({ name: 'excluded', xAxis: mark.index, yAxis: mark.value })) },
          markLine: { symbol: 'circle', lineStyle: { color: tokens.stageAwake, type: 'dashed' as const },
            label: { color: tokens.stageAwake, fontSize: base.axisLabel.fontSize, formatter: (p: { name: string }) => p.name },
            // Same index-not-label positioning as the markPoint above, and the same reason: a day
            // outside the visible range used to share its day-of-month label with a real day in
            // range and land on that day instead (chart-marks.test.tsx's own regression case
            // for the single-month version of this; the two-month version, where a label repeats
            // inside one visible range rather than only across an excluded one, is the same defect
            // one filter short of catching, closed the same way here).
            //
            // dayMarks groups by date first: an override reason, a note and an event can share one
            // date, and one markLine entry per annotation put every one of them at the same xAxis
            // with a label echarts anchors at the identical point (position: 'end' by default),
            // overlapping rather than reading apart. One mark per date, its texts joined with
            // ANNOTATION_JOIN, the same separator the accessible table beside this chart uses.
            //
            // An excluded day with no mean left is in this same list, drawn by position because
            // there is no value under it to sit on, and styled with the excluded colour and a solid
            // line so it does not read as an ordinary annotation. Its label already carries the
            // word "excluded" ahead of the reason, so the line says on the canvas what the table
            // row says in text.
            data: marks.atDate.map((mark) => ({ name: mark.text, xAxis: mark.index,
              ...(mark.excluded && { lineStyle: { color: tokens.excluded, type: 'solid' as const } }) })) } },
      ],
    }
  }, [days, baseline, marks, t, i18n.language, showBand])

  const onClick = useCallback((event: ECElementEvent) => {
    const date = heartRateRangePointDate(days, marks, event)
    if (date !== undefined) onPointClick?.(date)
  }, [days, marks, onPointClick])

  // The same resolver as onClick, so the annotate control below the breakpoint names exactly the
  // point a click would have opened - including a tap on the band, which resolves to the same day
  // as the mean line above it.
  const describe = useCallback((event: ECElementEvent) => {
    const date = heartRateRangePointDate(days, marks, event)
    return date === undefined ? undefined : formatLocalDate(date, i18n.language)
  }, [days, marks, i18n.language])

  // Conditional on the caller having somewhere to send a click, not unconditional: `onClick`
  // above bottoms out in `onPointClick?.(...)`, so handing useChart a pair it can never act on
  // renders an annotate control that names a point and then does nothing when pressed. See
  // useChart's ChartPointHandlers doc comment; chart-annotate-handlers.test.tsx pins it.
  const { host, style, tap } = useChart(build, 170, onPointClick ? { onClick, describe } : undefined)
  return (
    <>
      {/* Section 11's own named example of a card level control. aria-pressed carries the state
          for a screen reader the same way the visible label does for a sighted one; the label
          itself already says what a click does next, so it needs no separate aria-label. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-1)' }}>
        <button type="button" className="button" onClick={() => setShowBand((current) => !current)}
          aria-pressed={showBand}>
          {t(showBand ? 'charts.bandToggle.hide' : 'charts.bandToggle.show')}
        </button>
      </div>
      <ChartFigure label={label} host={host} style={style} tap={tap}
        table={{
          // The minimum and maximum columns leave together with the band's series, from the same
          // showBand flag: a screen reader user toggling this gets the same change a sighted one
          // does, rather than a table that still lists numbers the canvas no longer draws.
          columns: [
            t('charts.columns.date'),
            ...(showBand ? [t('charts.columns.minimum')] : []),
            t('charts.columns.mean'),
            ...(showBand ? [t('charts.columns.maximum')] : []),
            t('charts.columns.note'),
          ],
          rows: days.map((d) => {
            const isExcluded = excluded.includes(d.date)
            // "excluded", not "no reading", in all three value cells of a day the reader threw out:
            // there were readings, and they are gone because of something they did. All three at
            // once because a day_metric exclusion names the metric, so min, mean and max leave
            // together. See Sparkline's own copy of this for the same rule on one column.
            const absent = t(isExcluded ? 'charts.absence.excluded' : 'charts.absence.noReading')
            return [
              d.date,
              ...(showBand ? [formatMetricValue(d.hrMin, 'heart_rate', i18n.language, absent)] : []),
              formatMetricValue(d.hrMean, 'heart_rate', i18n.language, absent),
              ...(showBand ? [formatMetricValue(d.hrMax, 'heart_rate', i18n.language, absent)] : []),
              [!d.worn ? t('charts.absence.notWorn') : '', isExcluded ? t('charts.absence.excluded') : '',
                // filter, not find: several annotations (an override reason, a note, an event) can
                // land on the same date now that day level marks join the per-metric ones, and a
                // single find() here would silently show only the first and drop the rest.
                // ANNOTATION_JOIN, not a second ', ' literal: see Sparkline.tsx's own comment on
                // the same line for why.
                annotations.filter((a) => a.date === d.date).map((a) => a.text).join(ANNOTATION_JOIN)]
                .filter(Boolean).join(ANNOTATION_JOIN),
            ]
          }),
        }} />
      {/* The baseline band (markArea above, gated on the `baseline` prop) is a different overlay
          from the min/max band this toggle controls: it is drawn on the chart's canvas, which a
          test cannot query. This is a deliberate, invisible seam so a test can assert the
          baseline band's presence without depending on echarts' internal structure or on D1's
          token classes, which are free to change. */}
      {baseline && <span data-baseline-band aria-hidden="true" style={{ display: 'none' }} />}
    </>
  )
}
