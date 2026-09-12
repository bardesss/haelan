import { useCallback, useMemo } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from './useChart.js'
import { chartBase, OPACITY, STROKE, SYMBOL, tip } from './base.js'
import { scaleStops } from './tokens.js'
import type { ChartTokens } from './tokens.js'
import { ChartFigure } from './ChartFigure.js'
import { useTranslation } from '../i18n/index.js'
import { formatMetricValue } from '../format.js'
import type { Translate } from '../format.js'
import type { IntradayPoint, IntradayResult } from '../data/useIntraday.js'
import { useSession } from '../auth/session.js'
import { useSourceNames } from '../data/useSourceNames.js'

type Props = {
  points: IntradayPoint[]
  // Unread by this component: the chart draws `points` regardless of how they got here. Named and
  // typed to match `IntradayResult` field for field anyway, so a caller wiring this chart to
  // `useIntraday` can spread the query's own result (`{points, reduction}`) onto this component
  // directly, the same object it separately hands `intradayBasis` below to build the card's basis.
  reduction: IntradayResult['reduction']
  label: string
  // Handed the clicked point's own sourceId, utcMs and n, the three fields a sample scoped target
  // needs (AnnotatePanel.tsx's own AnnotateTarget), rather than a single localDate the way the
  // day_metric charts' onPointClick reports: a click here names one (source, minute) bucket, not
  // a day, and the panel's Correct guard needs n to decide whether that bucket is one stored row.
  onPointClick?: (point: { sourceId: string, utcMs: number, n: number }) => void
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
 * A point's time of day, rendered in `timeZone` rather than wherever this code happens to run.
 *
 * This answers a different question than the one IntradayPoint's own missing tzOffsetMinutes
 * would: readIntraday (packages/core/src/query/intraday.ts) reads each row's own recording offset
 * server side only to decide which local day a reading belongs to, and does not return it, so there
 * is no way to recover the offset a reading was actually taken under once a point reaches this
 * file. That is not what a reader wants displayed anyway; a reader wants their OWN configured zone
 * (`session.timezone`, `IntradayHeartRate` below), the same zone usePageControls already reads off
 * the session to compute "the person's today, not the browser's" (usePageControls.ts). `timeZone`
 * is always passed in explicitly, never defaulted here, so this function cannot quietly fall back
 * to the runtime's own machine zone the way `Intl.DateTimeFormat` does when the option is omitted:
 * the same reason periodLabel.ts pins `timeZone: 'UTC'` on every one of its own formatters rather
 * than leaving it implicit. `hourCycle: 'h23'` for the same reason: 'en' has no region attached
 * here to imply a clock convention, and Node's ICU data defaults a bare 'en' to a 12 hour clock
 * (confirmed by this file's own now-fixed test, which read "08:00 PM" before this was added), which
 * every other clock rendered by this app (formatClock, OverrideList's own timeStyle) already avoids.
 */
function timeOfDay(utcMs: number, timeZone: string, language: string): string {
  return new Date(utcMs).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone })
}

export function IntradayHeartRate({ points, label, onPointClick }: Props) {
  const { t, i18n } = useTranslation()
  const session = useSession()
  const { nameOf } = useSourceNames()
  // UTC while /api/auth/me is still pending (this component's first render, always, since the
  // session query starts unresolved) or has failed, rather than throwing: every point already has
  // a real instant regardless of whether the reader's own zone is known yet, and UTC is a real,
  // statable zone to show it in meanwhile, not a guess the way the runtime's own machine zone would
  // be (timeOfDay's own comment on why that guess is never used here, loaded or not).
  const timezone = session.data?.timezone ?? 'UTC'

  const series = useMemo(() => seriesBySource(points), [points])

  /**
   * Keyed by the series index of each source's mean line, not by its name.
   *
   * Three series per source in the order built below, mean last, so source i's mean line is
   * series 3i+2. The lookup used to key on `seriesName` and match the bare source id, which was
   * only safe while a series was named by its id: a name is a label, two sources can share one
   * (one person's alias can equal another source's provider name), and a tooltip that resolves a
   * hovered point by label would then report the wrong source's readings. An index cannot
   * collide.
   */
  const pointsBySeriesIndex = useMemo(
    () => new Map(series.map((s, i) => [i * 3 + 2, s.points])),
    [series],
  )

  // The excluded subset of each source's own points, keyed the same way and for the same reason
  // as pointsBySeriesIndex above: a click on the excluded marker itself reports the mean series'
  // own index but a dataIndex counting into that marker's own markPoint.data array, not into
  // `points`, so resolving it needs this second lookup rather than the first one indexed
  // differently (the same split Sparkline/HeartRateRange draw between a series click and an
  // overlay click, in base.ts's own dayMarks/markClickDate).
  const excludedBySeriesIndex = useMemo(
    () => new Map(series.map((s, i) => [i * 3 + 2, s.points.filter((p) => p.excluded)])),
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
            // Only a source's mean line has anything to report: the min and range series exist to
            // draw the band and carry no readings of their own.
            .filter((p): p is typeof p & { seriesIndex: number, dataIndex: number } =>
              typeof p.seriesIndex === 'number' && pointsBySeriesIndex.has(p.seriesIndex))
            .map((p) => {
              const point = pointsBySeriesIndex.get(p.seriesIndex)![p.dataIndex]
              if (!point) return ''
              const mean = formatMetricValue(point.mean, 'heart_rate', i18n.language, '')
              const min = formatMetricValue(point.min, 'heart_rate', i18n.language, '')
              const max = formatMetricValue(point.max, 'heart_rate', i18n.language, '')
              return tip`${timeOfDay(point.utcMs, timezone, i18n.language)} ${nameOf(point.sourceId)}`
                + tip`<br/>${t('charts.hrTooltip.mean', { value: mean })}`
                + tip`<br/>${t('charts.hrTooltip.range', { min, max })}`
            })
            .filter((line) => line !== '')
          return lines.join('<br/><br/>')
        },
      },
      xAxis: {
        type: 'time' as const,
        axisLabel: { ...base.axisLabel, formatter: (value: number) => timeOfDay(value, timezone, i18n.language) },
        axisLine: base.labelledAxis.axisLine,
      },
      yAxis: { type: 'value' as const, scale: true, splitLine: base.splitLine, axisLabel: base.axisLabel },
      series: series.flatMap(({ sourceId, points: ownPoints }, index) => {
        const color = colors[index % colors.length]!
        const label = nameOf(sourceId)
        // The stack key stays the id. It is not a label: it is what keeps two sources' bands from
        // being drawn on top of each other, and two sources can share a label.
        return [
          { name: `${label} min`, type: 'line' as const,
            data: ownPoints.map((p) => [p.utcMs, p.min]),
            showSymbol: false, connectNulls: false, lineStyle: { opacity: 0 },
            stack: `range-${sourceId}`, areaStyle: { opacity: 0 } },
          { name: `${label} range`, type: 'line' as const,
            data: ownPoints.map((p) => [p.utcMs, p.max !== null && p.min !== null ? p.max - p.min : null]),
            showSymbol: false, connectNulls: false, lineStyle: { opacity: 0 },
            stack: `range-${sourceId}`, areaStyle: { color: tokens.stageLight, opacity: OPACITY.rangeBand } },
          { name: label, type: 'line' as const,
            data: ownPoints.map((p) => [p.utcMs, p.mean]),
            showSymbol: false, connectNulls: false, lineStyle: { width: STROKE.series, color },
            // Same marker Sparkline and HeartRateRange draw over an excluded value (SYMBOL.excluded,
            // tokens.excluded): unlike their day scoped exclusion, a sample scoped one does not
            // remove the point from readIntraday's own aggregation (readIntraday's own comment on
            // `excluded` says why: the reading is still folded into min/mean/max), so the point is
            // always still here to anchor a marker on, never moved to a by-position mark the way
            // dayMarks moves a day with no value left.
            markPoint: { symbolSize: SYMBOL.excluded, itemStyle: { color: tokens.excluded },
              data: ownPoints.filter((p) => p.excluded).map((p) => ({
                name: 'excluded', coord: [p.utcMs, p.mean ?? p.max ?? p.min ?? 0],
              })) } },
        ]
      }),
    }
  }, [series, pointsBySeriesIndex, timezone, t, i18n.language, nameOf])

  const onClick = useCallback((event: ECElementEvent) => {
    const seriesIndex = event.seriesIndex
    if (seriesIndex === undefined) return
    const point = event.componentType === 'markPoint'
      ? excludedBySeriesIndex.get(seriesIndex)?.[event.dataIndex]
      : pointsBySeriesIndex.get(seriesIndex)?.[event.dataIndex]
    if (point !== undefined) onPointClick?.({ sourceId: point.sourceId, utcMs: point.utcMs, n: point.n })
  }, [pointsBySeriesIndex, excludedBySeriesIndex, onPointClick])

  const { host, style } = useChart(build, 170, onClick)
  return (
    <ChartFigure label={label} host={host} style={style}
      table={{
        columns: [
          t('charts.columns.time'), t('charts.columns.source'),
          t('charts.columns.minimum'), t('charts.columns.mean'), t('charts.columns.maximum'),
          t('charts.columns.note'),
        ],
        // The note column carries only "excluded", never a reason: unlike a day_metric exclusion
        // (whose reason reaches this chart's own annotations prop on the day_metric charts), a
        // sample override's reason lives with the row itself, on the corrections list
        // (Settings' own OverrideList), not threaded through readIntraday onto each point.
        rows: points.map((p) => {
          const absent = t('charts.absence.noReading')
          return [
            timeOfDay(p.utcMs, timezone, i18n.language),
            nameOf(p.sourceId),
            formatMetricValue(p.min, 'heart_rate', i18n.language, absent),
            formatMetricValue(p.mean, 'heart_rate', i18n.language, absent),
            formatMetricValue(p.max, 'heart_rate', i18n.language, absent),
            p.excluded ? t('charts.absence.excluded') : '',
          ]
        }),
      }} />
  )
}
