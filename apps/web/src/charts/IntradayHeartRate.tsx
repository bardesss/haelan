import { useCallback, useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, OPACITY, STROKE } from './base.js'
import { scaleStops } from './tokens.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatMetricValue } from '../format.js'
import type { Translate } from '../format.js'
import type { IntradayPoint, IntradayResult } from '../data/useIntraday.js'

type Props = {
  points: IntradayPoint[]
  // Unread by this component: the chart draws `points` regardless of how they got here. Named and
  // typed to match `IntradayResult` field for field anyway, so a caller wiring this chart to
  // `useIntraday` can spread the query's own result (`{points, reduction}`) onto this component
  // directly, the same object it separately hands `intradayBasis` below to build the card's basis.
  reduction: IntradayResult['reduction']
  label: string
}

/**
 * One series per source, each ordered by time.
 *
 * readIntraday pivots on source and minute together (packages/core/src/query/intraday.ts), because
 * two devices can report the same minute. Merging them here would invent a reading neither device
 * reported; picking a winner would drop one silently. A one source day takes this same path rather
 * than a shortcut, so the common case and the two device case cannot drift apart.
 */
export function seriesBySource(
  points: readonly IntradayPoint[],
): { sourceId: string, points: IntradayPoint[] }[] {
  const bySource = new Map<string, IntradayPoint[]>()
  for (const point of points) {
    const existing = bySource.get(point.sourceId)
    if (existing === undefined) bySource.set(point.sourceId, [point])
    else existing.push(point)
  }
  return [...bySource.entries()].map(([sourceId, ownPoints]) => ({
    sourceId,
    // The response interleaves sources, so a series taken in arrival order draws a line that
    // doubles back on itself.
    points: [...ownPoints].sort((a, b) => a.utcMs - b.utcMs),
  }))
}

/**
 * The card's basis line for this chart, kept out of the chart itself: `Card` (components/Card.tsx)
 * renders the basis, not the figure it describes, so a chart that tried to render its own would
 * either duplicate that text or fight it for the one `aria-describedby` slot ChartFigure publishes.
 *
 * The two cases say different things on purpose. `downsample.ts`'s own comment on `reduction`
 * spells out why the field is nullable at all: "so a client can tell 400 points that are the whole
 * series from 400 points standing in for 130,000". An object means these `count` points are not the
 * readings, they stand in for `from` of them, thinned down to `to`; null means nothing was thinned
 * and `count` points on the chart are `count` readings, no substitution to disclose. Collapsing the
 * two into one sentence, or treating null as "unknown", would throw away the one fact this field
 * exists to carry.
 */
export function intradayBasis(t: Translate, reduction: IntradayResult['reduction'], count: number): string {
  if (reduction === null) return t('charts.intradayBasis.full', { count })
  return t('charts.intradayBasis.thinned', { from: reduction.from, to: reduction.to })
}

/**
 * A point's time of day, rendered in UTC rather than the reader's own browser zone.
 *
 * IntradayPoint carries no tzOffsetMinutes: readIntraday (packages/core/src/query/intraday.ts)
 * reads each row's own offset server side, to decide which local day a reading belongs to, but does
 * not return it, so there is no way to recover the offset a reading was actually taken under from
 * utcMs alone once it reaches this file. The browser's own zone is not that offset either;
 * readIntraday's own comment states a reading keeps the offset it was recorded under even if the
 * person has since moved. UTC is not the true clock time the reading was taken at, but unlike the
 * reader's own machine zone it is at least the same answer on every machine, so the axis, the
 * tooltip and the table below cannot disagree with each other about what time a point was.
 */
function timeOfDay(utcMs: number, language: string): string {
  return new Date(utcMs).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
}

export function IntradayHeartRate({ points, label }: Props) {
  const { t, i18n } = useTranslation()

  const series = useMemo(() => seriesBySource(points), [points])

  // Read by the tooltip formatter to find the point a hovered mean-line sample names: `build`
  // draws each source's mean line off `s.points` directly (in this same order), so a dataIndex the
  // formatter gets back from that line counts into exactly this array.
  const pointsBySource = useMemo(
    () => new Map(series.map((s) => [s.sourceId, s.points])),
    [series],
  )

  const build = useCallback((tokens: ChartTokens): EChartsOption => {
    const base = chartBase(tokens)
    // series and seriesAlt first, since one or two sources is the ordinary case this chart was
    // written for; the sequential scale behind them is a fallback for a third device or more,
    // not a colour scheme chosen for its own sake.
    const colors = [tokens.series, tokens.seriesAlt, ...scaleStops(tokens)]
    return {
      grid: base.grid({ top: 18 }),
      tooltip: {
        ...base.tooltip,
        trigger: 'axis' as const,
        formatter: (params) => {
          const list = Array.isArray(params) ? params : [params]
          const lines = list
            // Only a source's mean line is named with the bare sourceId (the min/range lines
            // below carry a " min"/" range" suffix precisely so this lookup excludes them): the
            // other two exist only to draw the band and have nothing of their own to report.
            .filter((p): p is typeof p & { seriesName: string, dataIndex: number } =>
              typeof p.seriesName === 'string' && pointsBySource.has(p.seriesName))
            .map((p) => {
              const point = pointsBySource.get(p.seriesName)![p.dataIndex]
              if (!point) return ''
              const mean = formatMetricValue(point.mean, 'heart_rate', i18n.language, '')
              const min = formatMetricValue(point.min, 'heart_rate', i18n.language, '')
              const max = formatMetricValue(point.max, 'heart_rate', i18n.language, '')
              return `${timeOfDay(point.utcMs, i18n.language)} ${point.sourceId}`
                + `<br/>${t('charts.hrTooltip.mean', { value: mean })}`
                + `<br/>${t('charts.hrTooltip.range', { min, max })}`
            })
            .filter((line) => line !== '')
          return lines.join('<br/><br/>')
        },
      },
      xAxis: {
        type: 'time' as const,
        axisLabel: { ...base.axisLabel, formatter: (value: number) => timeOfDay(value, i18n.language) },
        axisLine: base.labelledAxis.axisLine,
      },
      yAxis: { type: 'value' as const, scale: true, splitLine: base.splitLine, axisLabel: base.axisLabel },
      series: series.flatMap(({ sourceId, points: ownPoints }, index) => {
        const color = colors[index % colors.length]!
        // Stacked per source (`range-${sourceId}`), not one shared 'range' stack: the same band
        // technique Spo2Range and HeartRateRange use for a single source's own min/max range,
        // given a distinct stack key per source so two sources' bands are drawn independently
        // instead of piling one source's range on top of another's.
        return [
          { name: `${sourceId} min`, type: 'line' as const,
            data: ownPoints.map((p) => [p.utcMs, p.min]),
            showSymbol: false, connectNulls: false, lineStyle: { opacity: 0 },
            stack: `range-${sourceId}`, areaStyle: { opacity: 0 } },
          { name: `${sourceId} range`, type: 'line' as const,
            data: ownPoints.map((p) => [p.utcMs, p.max !== null && p.min !== null ? p.max - p.min : null]),
            showSymbol: false, connectNulls: false, lineStyle: { opacity: 0 },
            stack: `range-${sourceId}`, areaStyle: { color: tokens.stageLight, opacity: OPACITY.rangeBand } },
          { name: sourceId, type: 'line' as const,
            data: ownPoints.map((p) => [p.utcMs, p.mean]),
            showSymbol: false, connectNulls: false, lineStyle: { width: STROKE.series, color } },
        ]
      }),
    }
  }, [series, pointsBySource, t, i18n.language])

  const { host, style } = useChart(build, 170)
  return (
    <ChartFigure label={label} host={host} style={style}
      table={{
        columns: [
          t('charts.columns.time'), t('charts.columns.source'),
          t('charts.columns.minimum'), t('charts.columns.mean'), t('charts.columns.maximum'),
        ],
        rows: points.map((p) => {
          const absent = t('charts.absence.noReading')
          return [
            timeOfDay(p.utcMs, i18n.language),
            p.sourceId,
            formatMetricValue(p.min, 'heart_rate', i18n.language, absent),
            formatMetricValue(p.mean, 'heart_rate', i18n.language, absent),
            formatMetricValue(p.max, 'heart_rate', i18n.language, absent),
          ]
        }),
      }} />
  )
}
