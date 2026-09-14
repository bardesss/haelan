import { useCallback, useMemo } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { ANNOTATION_JOIN, chartBase, dayMarks, markClickDate, OPACITY, STROKE, SYMBOL, tip } from './base.js'
import type { DayMarks } from './base.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatLocalDate, formatMetricValue, formatNumber } from '../format.js'

/**
 * A second copy of HeartRateRange's shape, not a rename of it. HeartRateRange names its own
 * fields hrMin/hrMean/hrMax, carries an optional baseline band this chart has no equivalent of,
 * and it is the chart a Critical was fixed in during M3c: a mark positioned with `date.slice(8)`,
 * a day-of-month label that repeats the moment a range spans two months, landed on the wrong day
 * at another day's height while the accessible table correctly disagreed. This file avoids that
 * by resolving every mark's index through `dayMarks` (base.ts), never through a label.
 *
 * Two copies of one shape is what this project's own rule allows, cheap at two and a refactor at
 * four; two range charts (this one and HeartRateRange) are still on the cheap side of that line.
 */
export type Spo2Day = {
  date: string
  min: number | null
  mean: number | null
  max: number | null
  count: number | null
}

type Props = {
  days: Spo2Day[]
  annotations: { date: string; text: string }[]
  excluded: string[]
  label: string
  onPointClick?: (localDate: string) => void
}

/**
 * Which local date a click on this chart landed on. The same device HeartRateRange's own
 * heartRateRangePointDate is, for the same reason: a click on one of the min/range/mean series
 * reads `days` by dataIndex (the three series share one category axis, by position), and a click
 * on an overlay mark reads the mark it actually hit, whose dataIndex counts into that overlay's
 * own data array instead.
 */
export function spo2RangePointDate(
  days: Spo2Day[], marks: DayMarks, event: Pick<ECElementEvent, 'componentType' | 'dataIndex'>,
): string | undefined {
  if (event.componentType !== 'series') return markClickDate(marks, event)
  return days[event.dataIndex]?.date
}

export function Spo2Range({ days, annotations, excluded, label, onPointClick }: Props) {
  const { t, i18n } = useTranslation()

  // Memoised, and read by both `build` and `onClick`, for the reason DayMarks' own doc comment
  // gives: the echarts entries and the click lookup have to come off the one list or they can
  // disagree about which mark a dataIndex names.
  const marks = useMemo(() => dayMarks({
    dates: days.map((d) => d.date), values: days.map((d) => d.mean),
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
        // (marks.atValue / marks.atDate), never into `days`; resolving through `marks` first, the
        // same list `build` drew the marks from, keeps the two from disagreeing. See
        // HeartRateRange.tsx's own identical comment for the full account.
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
          const day = days[p.dataIndex]
          if (!day) return ''
          if (day.mean === null || day.min === null || day.max === null) {
            return tip`${day.date}<br/>${t('charts.absence.noReading')}`
          }
          // Every number here goes through formatMetricValue/formatNumber before it ever reaches
          // t(), the same rule hrTooltip.ts states: a raw /series float reaching a reader
          // unrounded, and the words around it staying English regardless of the app's language,
          // is exactly the bug that rule closes.
          const mean = formatMetricValue(day.mean, 'spo2', i18n.language, '')
          const min = formatMetricValue(day.min, 'spo2', i18n.language, '')
          const max = formatMetricValue(day.max, 'spo2', i18n.language, '')
          // The one exception to the rule two lines up: `count` is the name i18next reads to pick
          // between charts.spo2Tooltip.count_one and _other, and it only looks at that name when
          // the option is a genuine number. formatNumber's own return type is a string, which is
          // right for every value above (each is inert text by the time t() sees it) and wrong
          // here specifically, since a preformatted "1" would make i18next skip plural selection
          // and always fall through to _other ("1 readings"). day.count is already a whole number
          // (packages/core/src/derive/metrics.ts's own `count` agg), so nothing here needs
          // rounding or locale grouping; ?? 0 only guards the type (min/max/mean gate null above,
          // but count is not itself part of that guard) and is never expected to fire in practice.
          return tip`${day.date}<br/>${t('charts.spo2Tooltip.mean', { value: mean })}`
            + tip`<br/>${t('charts.spo2Tooltip.range', { min, max })}`
            + tip`<br/>${t('charts.spo2Tooltip.count', { count: day.count ?? 0 })}`
        },
      },
      xAxis: { type: 'category' as const, data: days.map((d) => d.date.slice(8)), ...base.labelledAxis },
      yAxis: { type: 'value' as const, scale: true, splitLine: base.splitLine, axisLabel: base.axisLabel },
      series: [
        { name: 'min', type: 'line' as const, data: days.map((d) => d.min), showSymbol: false, connectNulls: false,
          lineStyle: { opacity: 0 }, stack: 'range', areaStyle: { opacity: 0 } },
        { name: 'range', type: 'line' as const, data: days.map((d) => (d.max !== null && d.min !== null ? d.max - d.min : null)),
          showSymbol: false, connectNulls: false, lineStyle: { opacity: 0 }, stack: 'range',
          areaStyle: { color: tokens.stageLight, opacity: OPACITY.rangeBand } },
        { name: 'mean', type: 'line' as const, data: days.map((d) => d.mean), showSymbol: false, connectNulls: false,
          lineStyle: { width: STROKE.series, color: tokens.series },
          markPoint: { symbolSize: SYMBOL.excluded, itemStyle: { color: tokens.excluded },
            // markPoint's explicit coordinates skip axis extent calculation, so a placeholder y lands off the fitted range.
            // Anchor each marker at the day's actual mean instead. dayMarks has already moved an excluded day whose mean
            // is gone to `atDate`, where it is drawn by position and needs no y, so everything left here is a day whose
            // mean is still drawn under its mark.
            //
            // xAxis is the day's own array position, never `date.slice(8)`: the axis itself is
            // still labelled by day-of-month for display (below), but a category axis's
            // markPoint/markLine `xAxis` resolves a string against that label by name, and the
            // label repeats the moment a range crosses a month boundary. See this file's own top
            // comment and HeartRateRange's identical note for the incident that made this the rule.
            data: marks.atValue.map((mark) => ({ name: 'excluded', xAxis: mark.index, yAxis: mark.value })) },
          markLine: { symbol: 'circle', lineStyle: { color: tokens.stageAwake, type: 'dashed' as const },
            label: { color: tokens.stageAwake, fontSize: base.axisLabel.fontSize, formatter: (p: { name: string }) => p.name },
            // Same index-not-label positioning as the markPoint above, and the same reason.
            //
            // dayMarks groups by date first: an override reason, a note and an event can share one
            // date, and one markLine entry per annotation put every one of them at the same xAxis
            // with a label echarts anchors at the identical point, overlapping rather than reading
            // apart. One mark per date, its texts joined with ANNOTATION_JOIN, the same separator
            // the accessible table beside this chart uses.
            data: marks.atDate.map((mark) => ({ name: mark.text, xAxis: mark.index,
              ...(mark.excluded && { lineStyle: { color: tokens.excluded, type: 'solid' as const } }) })) } },
      ],
    }
  }, [days, marks, t, i18n.language])

  const onClick = useCallback((event: ECElementEvent) => {
    const date = spo2RangePointDate(days, marks, event)
    if (date !== undefined) onPointClick?.(date)
  }, [days, marks, onPointClick])

  // The same resolver as onClick, so the annotate control below the breakpoint names exactly the
  // point a click would have opened.
  const describe = useCallback((event: ECElementEvent) => {
    const date = spo2RangePointDate(days, marks, event)
    return date === undefined ? undefined : formatLocalDate(date, i18n.language)
  }, [days, marks, i18n.language])

  const { host, style, tap } = useChart(build, 170, { onClick, describe })
  return (
    <ChartFigure label={label} host={host} style={style} tap={tap}
      table={{
        columns: [
          t('charts.columns.date'), t('charts.columns.minimum'), t('charts.columns.mean'),
          t('charts.columns.maximum'), t('charts.columns.count'), t('charts.columns.note'),
        ],
        rows: days.map((d) => {
          const isExcluded = excluded.includes(d.date)
          // "excluded", not "no reading", in every value cell of a day the reader threw out:
          // there were readings, and they are gone because of something the reader did. All four
          // at once (min, mean, max, count) because a day_metric exclusion names the metric, so
          // every agg on it leaves together. See HeartRateRange.tsx's own copy of this rule.
          const absent = t(isExcluded ? 'charts.absence.excluded' : 'charts.absence.noReading')
          return [
            d.date,
            formatMetricValue(d.min, 'spo2', i18n.language, absent),
            formatMetricValue(d.mean, 'spo2', i18n.language, absent),
            formatMetricValue(d.max, 'spo2', i18n.language, absent),
            formatNumber(d.count, 0, i18n.language, absent),
            [isExcluded ? t('charts.absence.excluded') : '',
              // filter, not find: several annotations (an override reason, a note, an event) can
              // land on the same date, and a single find() here would silently show only the
              // first and drop the rest. See HeartRateRange.tsx's own identical comment.
              annotations.filter((a) => a.date === d.date).map((a) => a.text).join(ANNOTATION_JOIN)]
              .filter(Boolean).join(ANNOTATION_JOIN),
          ]
        }),
      }} />
  )
}
