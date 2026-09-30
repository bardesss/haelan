import { useCallback } from 'react'
import type { EChartsOption, CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, OPACITY, STROKE, SYMBOL } from './base.js'
import type { ChartTokens } from './tokens.js'
import { nightMark, noDataYFor, axisTickInterval, fitWindow, type Night } from './schedule.js'
import { ChartFigure } from './ChartFigure.js'
import { formatClock } from '../format.js'
import { useTranslation } from '../i18n/index.js'
import { scheduleTooltip } from './scheduleTooltip.js'

// The canonical values, and the window arithmetic that reads them, now live in schedule.ts (its
// own pure, unit tested home); re-exported here for existing callers (Dashboard.tsx,
// schedule-marks.test.ts) that import them from this module.
export { AXIS_MIN, AXIS_MAX, NO_DATA_Y } from './schedule.js'

// A stable empty default, so a caller drawing no bands never hands the chart a fresh array.
const NO_BANDS: readonly { low: number, high: number }[] = []

export function SleepSchedule({ nights, label, showNaps = true, axisWindow, usualBands = NO_BANDS }: {
  nights: Night[]
  label: string
  showNaps?: boolean
  // Usual bed and wake ranges shaded across the whole chart, already placed in the same frame as
  // the nights' own bed and wake (the caller's job, as placing the nights is; placedUsualBand in
  // schedule.ts does it for both callers). The night page passes its bedtime and wake time usuals,
  // the Sleep page its latest night's, and neither one that is thin, the rule every usual band
  // keeps. Memoise it: it reaches the chart build.
  usualBands?: readonly { low: number, high: number }[]
  // Named axisWindow, not window: a plain `window` parameter shadows the DOM global, which this
  // file does not use today but a future edit here easily might reach for without noticing the
  // shadow.
  //
  // Optional, and left out by both pages today: the axis is fitted to what it draws - the nights,
  // and the naps too when they are drawn. A fixed window wide enough for every night and every
  // afternoon nap had to span 36 hours, and a 36 hour axis prints noon and midnight twice each,
  // which read as a clock that had lost its place. Fitted, an ordinary range spans well under a
  // day and no label repeats. The caller still places its nights in whatever frame it likes
  // (both use WIDE_WINDOW, so nothing is refused); this only chooses how much of that frame
  // to draw.
  axisWindow?: { min: number, max: number }
}) {
  const { t } = useTranslation()
  // The bands count toward the fit as spans of their own, so a usual that runs past every night
  // drawn this week is still on the axis rather than clipped off its edge.
  const resolvedWindow = axisWindow ?? fitWindow(
    usualBands.length === 0 ? nights : [...nights, ...usualBands.map((b) => ({ bed: b.low, wake: b.high }))],
    { naps: showNaps })

  const build = useCallback((tokens: ChartTokens): EChartsOption => {
    const base = chartBase(tokens)
    const noDataY = noDataYFor(resolvedWindow)
    return {
      grid: base.grid({ left: 40 }),
      tooltip: {
        ...base.tooltip,
        trigger: 'item' as const,
        formatter: (params: unknown) => {
          const p = Array.isArray(params) ? params[0] : params
          return scheduleTooltip(nights, (p ?? {}) as { seriesType?: string; value?: unknown }, t)
        },
      },
      xAxis: { type: 'category' as const, data: nights.map((n) => n.date.slice(8)),
        ...base.labelledAxis, axisLabel: { ...base.axisLabel, interval: 4 } },
      yAxis: { type: 'value' as const, min: resolvedWindow.min, max: resolvedWindow.max, inverse: false,
        // Explicit, not ECharts's own automatic "nice number" search: axisTickInterval's own
        // comment has the reproduction and the reasoning, but in short, the default search does
        // not know this axis wraps every 1440 minutes and picked an interval that left one tick,
        // and its label, off the evenly spaced grid the rest of the axis draws.
        interval: axisTickInterval(resolvedWindow),
        // A span of a day or more puts the same clock time at both ends; only the lower one is
        // printed, so no label on the axis repeats another.
        axisLabel: { ...base.axisLabel, showMaxLabel: resolvedWindow.max - resolvedWindow.min < 1440,
          formatter: (v: number) => formatClock(v).slice(0, 2) + ':00' },
        splitLine: base.splitLine },
      series: [
        { type: 'custom' as const,
          renderItem: (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
            const night = nights[params.dataIndex]
            if (!night) return { type: 'group' as const, children: [] }
            const mark = nightMark(night, tokens)
            // Missing bed/wake is absence, not a zero-length span: draw a no-data mark so the gap stays visible.
            if (mark.kind === 'no-data') {
              const point = api.coord([Number(api.value(0)), noDataY])
              return {
                type: 'circle',
                shape: { cx: point[0] ?? 0, cy: point[1] ?? 0, r: SYMBOL.noData },
                style: { fill: mark.color },
              }
            }
            const top = api.coord([api.value(0), mark.bed])
            const bottom = api.coord([api.value(0), mark.wake])
            const span = {
              type: 'line' as const,
              shape: { x1: top[0] ?? 0, y1: top[1] ?? 0, x2: bottom[0] ?? 0, y2: bottom[1] ?? 0 },
              style: { stroke: mark.color, lineWidth: STROKE.nightSpan, lineCap: 'round' as const },
            }
            if (!mark.bedOut) return span
            // A bedtime outside its usual: a dot at the bed end, in the verdict's warning tone.
            return { type: 'group' as const, children: [span, {
              type: 'circle' as const,
              shape: { cx: top[0] ?? 0, cy: top[1] ?? 0, r: SYMBOL.bedOut },
              style: { fill: tokens.negative },
            }] }
          },
          encode: { x: 0 },
          // Each night's placed bed and wake ride along with its index, then whether it is a weekend
          // night and whether its bedtime is dotted (1 or 0), so the series data states what is drawn
          // (renderItem itself reads the night from `nights`).
          data: nights.map((n, i) => [i, n.bed, n.wake, n.weekend === true ? 1 : 0, n.bedOut === true ? 1 : 0]),
          ...(usualBands.length > 0 && { markArea: { silent: true,
            itemStyle: { color: tokens.band, opacity: OPACITY.baselineBand },
            data: usualBands.map((b) => [{ yAxis: b.low }, { yAxis: b.high }]) } }) },
        // Omitted rather than left to draw nothing: a caller passing showNaps=false is telling
        // this chart it has no nap data at all, and a data-less series is still a series, not the
        // same statement as one that was never asked to exist.
        ...(showNaps
          ? [{ type: 'scatter' as const, symbolSize: SYMBOL.nap, itemStyle: { color: tokens.stageAwake },
              data: nights.flatMap((n, i) => n.naps.map((nap) => [i, nap])) }]
          : []),
      ],
    }
    // axisWindow.min/max rather than axisWindow itself: this chart's own default is a module level
    // constant so it never churns, but a caller building its own window prop should not have to
    // guarantee object
    // identity across renders just to avoid disposing and rebuilding this chart every commit, the
    // defect useChart.ts's own doc comment already names for a freshly constructed array.
  }, [nights, showNaps, resolvedWindow.min, resolvedWindow.max, usualBands, t])

  const { host, style } = useChart(build, 150)
  const baseColumns = [t('charts.columns.night'), t('charts.columns.toBed'), t('charts.columns.woke')]
  // A "none" in a naps column states that a check was made and found nothing; this source has
  // never made that check (see the caller for why), so the honest move is to drop the column
  // rather than fill it with a claim nothing here can back.
  const columns = showNaps ? [...baseColumns, t('charts.columns.naps')] : baseColumns
  const rows = nights.map((n) => {
    const base = [
      n.date,
      n.bed === null ? t('charts.absence.noReading') : formatClock(n.bed),
      n.wake === null ? t('charts.absence.noReading') : formatClock(n.wake),
    ]
    return showNaps
      ? [...base, n.naps.length === 0 ? t('charts.absence.none') : n.naps.map((nap) => formatClock(nap)).join(', ')]
      : base
  })

  return <ChartFigure label={label} host={host} style={style} table={{ columns, rows }} />
}
