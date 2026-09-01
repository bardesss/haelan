import { useCallback, useMemo } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { ANNOTATION_JOIN, annotationsByDate, chartBase, SYMBOL } from './base.js'
import { scaleStops, type ChartTokens } from './tokens.js'
import { calendarLayout, type CalendarCell } from './calendar.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import type { DayRow } from '../fixtures/july.js'

// Order matches calendar.ts's weekdayIndex (Monday first); the catalogue keys underneath are
// what actually reach the page, calendar.ts's own WEEKDAY_LABELS stays English on purpose for
// the index-correctness test that pins it against real dates.
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

/**
 * Which local date a click on this heatmap landed on: a cell click carries a [week, weekday, ...]
 * tuple that names a cell, and a click on one of the overlay marks carries a marker descriptor
 * instead, resolved through `markDates` by the markPoint's own dataIndex.
 *
 * `markDates` is the date of every markPoint entry, in the order this chart hands them to echarts,
 * which is the only handle an overlay click gives (its `value` is the descriptor, not a cell). An
 * overlay click used to resolve to nothing at all, and on this chart an excluded day's mark sits
 * directly on top of the absence dot for the same cell, so a click aimed at the mark a reader
 * wanted to undo landed on the mark and did nothing while a click a few pixels off worked.
 *
 * A plain function, exported and tested on its own for the same reason Sparkline's own
 * `sparklinePointDate` is: echarts renders to an SVG this project's render environment cannot
 * hit-test, so the translation from a click event to a date is the one piece of this behaviour a
 * test can reach. See chart-marks.test.tsx.
 */
export function heatmapClickDate(
  cells: CalendarCell[], markDates: readonly string[],
  // dataIndex optional rather than picked off ECElementEvent whole: a real click always carries
  // one, and only the markPoint branch below reads it, so requiring it would make every cell click
  // case in a test carry a number nothing looks at.
  event: Pick<ECElementEvent, 'componentType' | 'value'> & { dataIndex?: number },
): string | undefined {
  if (event.componentType === 'markPoint') {
    return event.dataIndex === undefined ? undefined : markDates[event.dataIndex]
  }
  if (event.componentType !== 'series') return undefined
  const value = event.value
  if (!Array.isArray(value)) return undefined
  const [week, weekday] = value as [unknown, unknown]
  return cells.find((c) => c.week === week && c.weekday === weekday)?.date
}

// A stable reference for a caller that omits annotations/excluded, the same device Sparkline's
// own EMPTY constant is and Dashboard.tsx's own EMPTY constant is: a default parameter expression
// that is a fresh `[]` literal runs on every call, handing `build`'s useCallback a new array
// identity on every render regardless of what actually changed, which is precisely the defect
// chart-lifecycle.test.tsx guards against.
const EMPTY = Object.freeze([]) as never[]

export function ActivityHeatmap({ days, max, label, annotations = EMPTY, excluded = EMPTY, onPointClick }: {
  days: DayRow[]
  max: number
  label: string
  // Same prop names and shapes HeartRateRange has taken since D1, so a page hands every chart type
  // the same annotations/excluded values instead of building a different shape per chart. Optional
  // here (HeartRateRange's own pair is required) because this chart's own default parameter (EMPTY,
  // below) has to exist regardless: a card can mount before its overrides query has answered.
  annotations?: { date: string; text: string }[]
  excluded?: string[]
  onPointClick?: (localDate: string) => void
}) {
  const { t, i18n } = useTranslation()
  // Memoised: an unstable build identity makes useChart dispose and recreate the chart.
  const { weeks, cells } = useMemo(() => calendarLayout(days.map((d) => d.date)), [days])
  // Also memoised, on the same grounds: a fresh array every render gave `build` a new identity
  // on every render regardless of the `cells` memoisation two lines up, and useChart disposes
  // and recreates the whole chart whenever `build` changes identity.
  const weekdayLabels = useMemo(() => WEEKDAY_KEYS.map((key) => t(`charts.weekday.${key}`)), [t])

  // Every markPoint this chart draws, resolved to its cell once, in the order echarts receives
  // them. `build` maps over this list and `onClick` indexes back into it, so a click on a mark and
  // the mark it was drawn from cannot come apart; assembling the entries in `build` and a second
  // parallel list of dates for the click handler is exactly the drift this avoids. Memoised for
  // the reason every other array on this chart is: a fresh one each render rebuilds `build` and
  // disposes the chart.
  //
  // Unlike Sparkline and HeartRateRange, nothing here has to move to a by-position mark when a
  // day's value is gone. A heatmap cell is a coordinate on two category axes rather than a height,
  // so an excluded day with no steps still has a cell to mark, which is why this chart kept its
  // excluded mark through the defect the other two lost theirs to.
  const marks = useMemo(() => [
    ...excluded.map((date) => ({ date, kind: 'excluded' as const, text: '' })),
    ...annotationsByDate(annotations).map((a) => ({ date: a.date, kind: 'annotation' as const, text: a.text })),
  ].flatMap((mark) => {
    const cell = cells.find((c) => c.date === mark.date)
    return cell === undefined ? [] : [{ ...mark, week: cell.week, weekday: cell.weekday }]
  }), [cells, excluded, annotations])

  const build = useCallback((tokens: ChartTokens): EChartsOption => {
    const base = chartBase(tokens)
    const worn = cells.flatMap((c, i) => {
      const steps = days[i]?.steps
      return steps === null || steps === undefined ? [] : [[c.week, c.weekday, steps]]
    })
    // Absence gets its own mark: an unpainted cell would be indistinguishable from the bottom of the scale.
    const absent = cells.flatMap((c, i) => (days[i]?.steps === null ? [[c.week, c.weekday]] : []))
    return {
      grid: base.grid({ left: 30, top: 10, bottom: 20 }),
      tooltip: {
        ...base.tooltip,
        // With no formatter, echarts renders a markPoint hover as its series name plus the
        // item name, and this series carries no `name`, so the series half of that came out
        // as echarts' own internal id ("series0") rather than nothing: a reader hovering an
        // excluded or annotated day saw that id sitting above the reason they wrote. And left
        // to its own default the ordinary cell case names a week index ("Week 5"), which is
        // exactly the coordinate the reader cannot read a date out of. Owning both cases here
        // means naming the real day either way, from `cells`/`days` rather than the axis
        // category label.
        formatter: (params) => {
          const p = Array.isArray(params) ? params[0] : params
          if (!p) return ''
          if (p.componentType === 'markPoint') {
            // dataIndex counts into this series' own markPoint data, which `marks` (above) was
            // built in lockstep with, the same contract heatmapClickDate's own click lookup
            // relies on: entry N drawn is entry N read back.
            const mark = marks[p.dataIndex]
            if (!mark) return ''
            const text = mark.kind === 'excluded' ? t('charts.absence.excluded') : mark.text
            return `${mark.date}<br/>${text}`
          }
          // The ordinary cell case, for both this chart's series: the worn heatmap and the
          // absent-day scatter. Both plot `[week, weekday, ...]`, so reading the cell off the
          // hovered point's own value (the same fields heatmapClickDate reads a click off)
          // works for either series without needing dataIndex, which counts into each series'
          // own filtered data and not into `cells`.
          const value = p.value
          if (p.componentType === 'series' && Array.isArray(value)) {
            const [week, weekday] = value as [number, number]
            const index = cells.findIndex((c) => c.week === week && c.weekday === weekday)
            const cell = cells[index]
            if (!cell) return ''
            const steps = days[index]?.steps
            // toLocaleString, not a bare template literal: echarts' own default rendered
            // thousands-grouped ("11,999"), and the accessible table beside this chart already
            // groups by the reader's own language (Activity.tsx's groupNumber, same reasoning).
            // i18n.language is a primitive in `build`'s own deps below, not a fresh identity per
            // render, so this carries no dispose risk beyond what `t` already causes on a language
            // change.
            const text = steps === null || steps === undefined
              ? t(excluded.includes(cell.date) ? 'charts.absence.excluded' : 'charts.absence.noReading')
              : `${t('charts.columns.steps')}: ${steps.toLocaleString(i18n.language)}`
            return `${cell.date}<br/>${text}`
          }
          return ''
        },
      },
      xAxis: {
        type: 'category' as const,
        data: Array.from({ length: weeks }, (_, i) => `Week ${i + 1}`),
        axisLabel: { show: false }, splitArea: { show: false }, ...base.hiddenAxis,
      },
      yAxis: {
        type: 'category' as const, data: weekdayLabels,
        axisLabel: base.axisLabel, ...base.hiddenAxis,
      },
      // seriesIndex: visualMap applies to every series by default and would repaint the absence dots too.
      visualMap: { min: 0, max, show: false, seriesIndex: 0, inRange: { color: scaleStops(tokens) } },
      series: [
        {
          type: 'heatmap' as const,
          data: worn,
          itemStyle: { borderRadius: 2, borderWidth: 1, borderColor: tokens.surface },
          emphasis: { itemStyle: { borderColor: tokens.axis } },
          // Coordinates are [week, weekday] on the same two category axes the cells themselves
          // are placed on, not a placeholder: a markPoint with no data-backed position would
          // collapse to the grid's origin rather than sitting on the day it names.
          markPoint: {
            symbolSize: SYMBOL.excluded,
            // Suppressed for the whole markPoint, not per entry: excluded and annotation marks
            // share this one series' markPoint, so a date carrying an override mark and an
            // annotation mark lands two entries on the identical coord (a day_metric override is
            // reachable alongside a note or an event since Task 11b). Two entries at one coord
            // means two labels at the identical anchor, occluding rather than reading apart.
            // Suppressing the label here is the same device Sparkline's own annotation markLine
            // already uses (`label: { show: false }`): the full text belongs in the accessible
            // table beside this chart, not fighting for the same pixel on the canvas, and shape
            // (circle against diamond) plus colour still tell the two groups apart with no label at
            // all, which is what Task 11's own Important 4 requires for a colour-blind reader too.
            label: { show: false },
            // A diamond in the annotation colour HeartRateRange's own markLine uses for an
            // annotation, against the excluded mark's own circle, so the two read apart at a glance.
            //
            // The annotation marks are grouped by date before they reach `marks` above: an override
            // reason, a note and an event can share one date, and one markPoint entry per
            // annotation put every one of them at the same coord, overlapping rather than reading
            // apart. Their texts are joined with ANNOTATION_JOIN, the same separator the accessible
            // table below uses.
            data: marks.map((mark) => {
              const coord = [mark.week, mark.weekday]
              return mark.kind === 'excluded'
                ? { name: 'excluded', coord, itemStyle: { color: tokens.excluded } }
                : { name: mark.text, coord, symbol: 'diamond', itemStyle: { color: tokens.stageAwake } }
            }),
          },
        },
        {
          type: 'scatter' as const,
          symbolSize: SYMBOL.noData * 2,
          itemStyle: { color: tokens.noData },
          data: absent,
        },
      ],
    }
  }, [cells, days, weeks, max, weekdayLabels, marks, excluded, t, i18n.language])

  const markDates = useMemo(() => marks.map((mark) => mark.date), [marks])
  const onClick = useCallback((event: ECElementEvent) => {
    const date = heatmapClickDate(cells, markDates, event)
    if (date !== undefined) onPointClick?.(date)
  }, [cells, markDates, onPointClick])

  const { host, style } = useChart(build, 110, onClick)
  return (
    <ChartFigure label={label} host={host} style={style}
      table={{
        columns: [t('charts.columns.date'), t('charts.columns.weekday'), t('charts.columns.steps'), t('charts.columns.note')],
        // A day's own DayRow.steps is only ever null because no point exists for it (a real
        // reading is never itself null; see useSeries.ts), not because a coverage figure said the
        // device was off. "not worn" states a cause this table cannot establish; "no reading" is
        // the one thing that is always true of a blank cell.
        rows: cells.map((c, i) => {
          const isExcluded = excluded.includes(c.date)
          // "excluded", not "no reading", for a day the reader threw out: see Sparkline's own copy
          // of this comment for the rule.
          return [c.date, weekdayLabels[c.weekday] ?? '',
            days[i]?.steps ?? t(isExcluded ? 'charts.absence.excluded' : 'charts.absence.noReading'),
            [isExcluded ? t('charts.absence.excluded') : '',
              // filter, not find: several annotations (an override reason, a note, an event) can
              // land on the same date now that day level marks join the per-metric ones, and a
              // single find() here would silently show only the first and drop the rest.
              // ANNOTATION_JOIN, not a second ', ' literal: see Sparkline.tsx's own comment on the
              // same line for why.
              annotations.filter((a) => a.date === c.date).map((a) => a.text).join(ANNOTATION_JOIN)]
              .filter(Boolean).join(ANNOTATION_JOIN)]
        }),
      }} />
  )
}
