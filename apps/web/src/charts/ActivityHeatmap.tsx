import { useCallback, useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, SYMBOL } from './base.js'
import { scaleStops, type ChartTokens } from './tokens.js'
import { calendarLayout } from './calendar.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import type { DayRow } from '../fixtures/july.js'

// Order matches calendar.ts's weekdayIndex (Monday first); the catalogue keys underneath are
// what actually reach the page, calendar.ts's own WEEKDAY_LABELS stays English on purpose for
// the index-correctness test that pins it against real dates.
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

export function ActivityHeatmap({ days, max, label }: { days: DayRow[]; max: number; label: string }) {
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
        },
        {
          type: 'scatter' as const,
          symbolSize: SYMBOL.noData * 2,
          itemStyle: { color: tokens.noData },
          data: absent,
        },
      ],
    }
  }, [cells, days, weeks, max, weekdayLabels])

  const { host, style } = useChart(build, 110)
  return (
    <ChartFigure label={label} host={host} style={style}
      table={{
        columns: [t('charts.columns.date'), t('charts.columns.weekday'), t('charts.columns.steps')],
        // A day's own DayRow.steps is only ever null because no point exists for it (a real
        // reading is never itself null; see useSeries.ts), not because a coverage figure said the
        // device was off. "not worn" states a cause this table cannot establish; "no reading" is
        // the one thing that is always true of a blank cell.
        rows: cells.map((c, i) => [c.date, weekdayLabels[c.weekday] ?? '', days[i]?.steps ?? t('charts.absence.noReading')]),
      }} />
  )
}
