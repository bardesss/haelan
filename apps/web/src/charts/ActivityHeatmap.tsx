import { useCallback, useMemo } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, SYMBOL } from './base.js'
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
 * Which local date a click on this heatmap's own worn/absent cells landed on, or undefined for a
 * click that missed both series (a markPoint overlay, or empty grid space): a markPoint click
 * reports its own componentType rather than `'series'`, and its value is a marker descriptor, not
 * a [week, weekday, ...] cell tuple.
 *
 * A plain function, exported and tested on its own for the same reason Sparkline's own
 * `sparklinePointDate` is: echarts renders to an SVG this project's render environment cannot
 * hit-test, so the translation from a click event to a date is the one piece of this behaviour a
 * test can reach. See chart-annotations.test.tsx.
 */
export function heatmapClickDate(cells: CalendarCell[], event: Pick<ECElementEvent, 'componentType' | 'value'>): string | undefined {
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

export function ActivityHeatmap({ days, max, label, annotations = EMPTY, excluded = EMPTY, corrected = EMPTY, onPointClick }: {
  days: DayRow[]
  max: number
  label: string
  // Same prop names and shapes HeartRateRange has taken since D1, so a page hands every chart type
  // the same annotations/excluded/corrected values instead of building a different shape per chart.
  // Optional here (HeartRateRange's own trio is required) because this chart's own default
  // parameter (EMPTY, below) has to exist regardless: a card can mount before its overrides query
  // has answered.
  annotations?: { date: string; text: string }[]
  excluded?: string[]
  // Kept apart from `excluded`: a corrected day was not dropped, its replacement value is the
  // number already on screen, so marking it "excluded" would tell a reader the opposite of what
  // happened. See chartAnnotations.ts's own doc comment on `MetricAnnotations` for the full reasoning.
  corrected?: { date: string; value: number }[]
  onPointClick?: (localDate: string) => void
}) {
  const { t } = useTranslation()
  // Memoised: an unstable build identity makes useChart dispose and recreate the chart.
  const { weeks, cells } = useMemo(() => calendarLayout(days.map((d) => d.date)), [days])
  // Also memoised, on the same grounds: a fresh array every render gave `build` a new identity
  // on every render regardless of the `cells` memoisation two lines up, and useChart disposes
  // and recreates the whole chart whenever `build` changes identity.
  const weekdayLabels = useMemo(() => WEEKDAY_KEYS.map((key) => t(`charts.weekday.${key}`)), [t])

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
      tooltip: base.tooltip,
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
            data: [
              ...excluded.flatMap((date) => {
                const cell = cells.find((c) => c.date === date)
                return cell ? [{ name: 'excluded', coord: [cell.week, cell.weekday], itemStyle: { color: tokens.excluded } }] : []
              }),
              // A rect, the same shape and colour Sparkline's own corrected mark uses, so a
              // correction reads the same way on every chart that can draw one.
              ...corrected.flatMap((c) => {
                const cell = cells.find((candidate) => candidate.date === c.date)
                return cell
                  ? [{ name: 'corrected', coord: [cell.week, cell.weekday], symbol: 'rect', symbolSize: SYMBOL.corrected,
                    itemStyle: { color: tokens.seriesAlt } }]
                  : []
              }),
              // A diamond rather than the excluded mark's circle, and the annotation colour
              // HeartRateRange's own markLine uses, so the two kinds read apart at a glance.
              ...annotations.flatMap((a) => {
                const cell = cells.find((c) => c.date === a.date)
                return cell
                  ? [{ name: a.text, coord: [cell.week, cell.weekday], symbol: 'diamond', itemStyle: { color: tokens.stageAwake } }]
                  : []
              }),
            ],
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
  }, [cells, days, weeks, max, weekdayLabels, excluded, corrected, annotations])

  const onClick = useCallback((event: ECElementEvent) => {
    const date = heatmapClickDate(cells, event)
    if (date !== undefined) onPointClick?.(date)
  }, [cells, onPointClick])

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
          const correctedEntry = corrected.find((entry) => entry.date === c.date)
          return [c.date, weekdayLabels[c.weekday] ?? '', days[i]?.steps ?? t('charts.absence.noReading'),
            [excluded.includes(c.date) ? t('charts.absence.excluded') : '',
              correctedEntry ? t('charts.absence.correctedTo', { value: correctedEntry.value }) : '',
              annotations.find((a) => a.date === c.date)?.text ?? ''].filter(Boolean).join(', ')]
        }),
      }} />
  )
}
