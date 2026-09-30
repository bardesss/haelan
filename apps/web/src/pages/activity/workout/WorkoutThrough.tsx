import { useId, useMemo, useState } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
import { exerciseCategory, rateOf } from '@haelan/core/exercise-category'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { ErrorState } from '../../../components/ErrorState.js'
import { Loading } from '../../../components/Loading.js'
import { IntradayHeartRate, intradayBasis } from '../../../charts/IntradayHeartRate.js'
import type { ZoneBand } from '../../../charts/IntradayHeartRate.js'
import { ZONE_TOKENS } from '../../../charts/ZoneBar.js'
import { formatElapsed } from '../../../charts/elapsed.js'
import { useSourceTrace } from '../../../data/useSourceTrace.js'
import { useSourceNames } from '../../../data/useSourceNames.js'
import type { WorkoutSession, WorkoutSessionDetail } from '../../../data/useSessions.js'
import type { IntradayPoint } from '../../../data/useIntraday.js'
import type { MinuteSeries, PaceSeries, SpeedSeries, WorkoutFigure, WorkoutPageData } from '../../../data/useWorkoutPage.js'
import { formatNumber } from '../../../format.js'
import type { Translate } from '../../../format.js'
import { formatFigureValue, formatStopwatch } from '../../detail/figureText.js'
import { pausesOf } from './workoutText.js'

/**
 * The four zones as bands for the trace, from the server's bounds (the provider's own ceilings for
 * the day, workoutPage.ts's `zoneBounds`), in the zones card's colours (ZONE_TOKENS). Light has no
 * floor to send, so its band is open below. None without bounds.
 */
function zoneBandsOf(bounds: WorkoutPageData['zoneBounds'], t: Translate): ZoneBand[] | undefined {
  if (bounds === null) return undefined
  const band = (zone: keyof typeof ZONE_TOKENS, low: number | null, high: number): ZoneBand =>
    ({ low, high, label: t(`activity.workout.zones.${zone}`), token: ZONE_TOKENS[zone] })
  return [
    band('light', null, bounds.moderateMin),
    band('moderate', bounds.moderateMin, bounds.vigorousMin),
    band('vigorous', bounds.vigorousMin, bounds.peakMin),
    band('peak', bounds.peakMin, bounds.max),
  ]
}

/**
 * A minute series as chart points on the workout's own clock, each at its own elapsed seconds
 * (never by index: pace counts minutes from the start, cadence wall-clock minutes, and the two can
 * sit up to 59 s apart). A minute the series skips is a gap in the line, not a straight join across
 * it, so a reading with no value is put where the first missing minute would have been.
 */
export function minutePoints(series: MinuteSeries, startMs: number, sourceId: string): IntradayPoint[] {
  const at = (elapsedSeconds: number, value: number | null): IntradayPoint =>
    ({ sourceId, utcMs: startMs + elapsedSeconds * 1000, min: value, mean: value, max: value, n: 1, excluded: false })
  return series.points.flatMap((point, i) => {
    const before = series.points[i - 1]
    const gap = before !== undefined && point.elapsedSeconds - before.elapsedSeconds > 60
    return gap ? [at(before.elapsedSeconds + 60, null), at(point.elapsedSeconds, point.value)] : [at(point.elapsedSeconds, point.value)]
  })
}

// The height of each row under the heart rate, which keeps its own 170.
const SERIES_HEIGHT = 120

/**
 * The heading's words for the series' best minute, when the server named one: pace's fastest
 * ("fastest 5:18 /km at 14:00"), or a ride's highest speed, in the words the heart rate's highest
 * takes ("highest 32.4 km/h at 14:00"), since more of a speed is more, as more of a heart rate is.
 */
function bestMinute(series: MinuteSeries | PaceSeries | SpeedSeries, figure: { metric: string, value: null, unit: string, precision: number }, language: string, t: Translate): string | null {
  if (!('fastest' in series) || series.fastest === null) return null
  const time = formatElapsed(series.fastest.elapsedSeconds * 1000)
  if ('metersPerSecond' in series.fastest) {
    return t('activity.workout.page.through.highest', { value: formatFigureValue(figure, series.fastest.metersPerSecond, language, t), time })
  }
  return t('activity.workout.page.through.fastest', { value: formatFigureValue(figure, series.fastest.secondsPerKm, language, t), time })
}

/**
 * One series row's chart settings and words, memoised on the series: `single` reaches the chart's
 * build, and a fresh one every render would rebuild it. The average is the page's own figure for
 * the workout (the server's), never worked out from the series; so is the best minute (bestMinute),
 * which the heading names when the server sent one, as the heart rate's heading names its highest.
 * Pace is drawn upside down with a stopwatch axis; a ride's speed the right way up, its axis in
 * whole km/h.
 */
function useSeriesRow(series: MinuteSeries | PaceSeries | SpeedSeries | null, average: WorkoutFigure | undefined, key: 'pace' | 'speed' | 'cadence', startMs: number, sourceId: string) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  return useMemo(() => {
    if (series === null) return null
    const figure = { metric: key, value: null, unit: series.unit, precision: 0 }
    const averageText = average === undefined || average.value === null ? null : formatFigureValue(average, average.value, language, t)
    const formatAxis = key === 'pace' ? formatStopwatch
      : key === 'speed' ? (value: number) => formatNumber(value * 3.6, 0, language, '')
        : (value: number) => formatFigureValue({ ...figure, unit: 'count' }, value, language, t)
    return {
      points: minutePoints(series, startMs, sourceId),
      single: {
        column: t(`activity.workout.page.through.${key}`),
        formatValue: (value: number) => formatFigureValue(figure, value, language, t),
        formatAxis,
        inverse: key === 'pace',
        ...(average !== undefined && average.value !== null && averageText !== null && {
          reference: { value: average.value, label: t('activity.workout.page.through.averageShort', { value: averageText }) },
        }),
      },
      summary: bestMinute(series, figure, language, t)
        ?? (averageText === null ? null : t('activity.workout.page.through.average', { value: averageText })),
    }
  }, [series, average, key, startMs, sourceId, language, t])
}

/**
 * Through the workout (M10a-3): the heart rate on the workout's own clock, 0:00 to its end, with
 * the zones as bands behind it and its pauses shaded. Under it, on the same axis (M10b), the pace
 * (a ride's speed in its place) and the cadence a minute at a time as the server reads them
 * (`page.through`), each smoothed over three minutes and each with the workout's own average as a
 * dashed line. Pace is drawn upside down, since a faster minute is a smaller number, a speed the
 * right way up; both come from the route's own timestamps, so a workout without a route has none. Cadence comes from the steps the workout's own device
 * logged, and is missing where those rows are further apart than a minute (a device that logs
 * steps in longer intervals), where only another device logged steps, and on a workout longer
 * than the window read allows. The lowest drawn row labels the time for all of them.
 *
 * Pinned to the device that recorded the workout unless it logged nothing, as WorkoutTrace was
 * (useSourceTrace's own rule), and the line under the chart says so when the fallback fired.
 * A pause with both ends is shaded; one with no end after it stays a mark (pausesOf).
 */
export function WorkoutThrough({ session, detail, page, chosenSource }: {
  session: WorkoutSessionDetail
  detail: WorkoutDetail
  page: WorkoutPageData
  chosenSource: string | null
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const { nameOf } = useSourceNames()
  const headId = useId()
  const tableIds = useId()
  // One show-numbers control for the card when it stacks two charts or more, as the approved
  // mockup draws it: a control under each chart put a line between rows meant to read as one.
  const [tablesShown, setTablesShown] = useState(false)
  const trace = useSourceTrace({
    metric: 'heart_rate', startMs: session.startMs, endMs: session.endMs,
    sessionSourceId: session.sourceId, chosenSource,
  })
  // Memoised: each reaches the chart's build, and a fresh reference every render rebuilds it.
  const pauses = useMemo(() => pausesOf(detail.events, session.endMs), [detail.events, session.endMs])
  const zoneBands = useMemo(() => zoneBandsOf(page.zoneBounds, t), [page.zoneBounds, t])
  // A ride's speed takes pace's row; the server sends one or the other. `speed` is read
  // defensively: a response cached from before the field existed lacks it.
  const speedSeries = (page.through.speed as SpeedSeries | null | undefined) ?? null
  const rateKey = speedSeries === null ? 'pace' : 'speed'
  const rate = useSeriesRow(speedSeries ?? page.through.pace, page.figures[rateKey], rateKey, session.startMs, session.sourceId)
  const cadence = useSeriesRow(page.through.cadence, page.figures.cadence, 'cadence', session.startMs, session.sourceId)

  const label = t('activity.workout.page.through.label')
  if (trace.isError) {
    return <Card span={12} label={label}><ErrorState onRetry={() => trace.refetch()} error={trace.error} /></Card>
  }
  if (trace.isPending) return <Card span={12} label={label}><Loading /></Card>
  // Which of the two series is drawn, as the catalogue names the case. A ride has no cadence, so
  // its speed is only ever drawn alone.
  const both = rate === null && cadence === null ? null : rate === null ? 'cadence' : cadence === null ? rateKey : 'both'
  // No heart rate in this window from any device, fallback included, leaves its row out; the card
  // stays for a pace or a cadence, and is absent, not an empty chart, with none of the three.
  const hasTrace = trace.points.length > 0
  if (!hasTrace && both === null) return null
  // A response cached from before a field existed can lack `route`.
  const routePoints = (session.route as WorkoutSessionDetail['route'] | undefined)?.length ?? 0
  const lineRate = rateOf(exerciseCategory(page.exerciseType))
  const pausedMs = pauses.spans.reduce((sum, span) => sum + span.endMs - span.startMs, 0)
  const basis = [
    t('activity.workout.page.through.basis', { end: formatElapsed(session.endMs - session.startMs) }),
    ...(pauses.spans.length === 0 ? [] : [t('activity.workout.page.through.pauses', { count: pauses.spans.length, duration: formatElapsed(pausedMs) })]),
    ...(both === null ? [] : [t(`activity.workout.page.through.smoothed.${both}`)]),
    // Only a workout that covers a distance and has no route points is missing its pace for want of
    // a route; a route whose minutes all fail the pace rules says nothing here.
    // Worded for the line the category would draw: a ride's speed, anything else's pace. Never for
    // a swim: a pool has no route to lack, so saying one is missing reads as a fault.
    ...(rate === null && page.figures.distance !== undefined && routePoints === 0 && lineRate !== 'swimPace'
      ? [t(lineRate === 'speed' ? 'activity.workout.page.through.noRouteSpeed' : 'activity.workout.page.through.noRoute')]
      : []),
  ].join(' · ')

  // The highest reading is the server's figure; when in the workout it came is read off the trace.
  const highest = page.figures.highestHeartRate
  const highestAt = highest === undefined || highest.value === null ? undefined
    : trace.points.find((p) => p.max === highest.value)?.utcMs
  const summary = highest === undefined || highest.value === null ? null
    : highestAt === undefined
      ? t('activity.workout.page.through.highestOnly', { value: formatFigureValue(highest, highest.value, language, t) })
      : t('activity.workout.page.through.highest', {
        value: formatFigureValue(highest, highest.value, language, t), time: formatElapsed(highestAt - session.startMs),
      })

  // What the line under the chart owns up to: a trace from another device, or a thinned one.
  const note = trace.traceSource === 'otherSources'
    ? t('activity.workout.trace.basisFellBack', {
      pinned: nameOf(trace.pinnedSourceId), detail: intradayBasis(t, trace.reduction, trace.points.length),
    })
    : trace.reduction === null ? null : intradayBasis(t, trace.reduction, trace.points.length)
  // Where the two series come from: a sentence of its own, or after the note about the heart rate
  // its continuation, joined by the note's own semicolon ("…are the readings; the pace comes …"),
  // since the note ends without a full stop. A response cached from before a field existed can
  // lack `route` (the same shape WorkoutSplits survives).
  const seriesFrom = both === null ? null
    : t(`activity.workout.page.through.${note === null ? 'from' : 'fromAfter'}.${both}`, { count: routePoints })
  const noteLine = note === null ? seriesFrom : seriesFrom === null ? note : `${note}; ${seriesFrom}`
  // Each drawn chart's table id, in the order drawn; one chart alone keeps its own control.
  const tables = [hasTrace && 'heart', rate !== null && rateKey, cadence !== null && 'cadence']
    .flatMap((row) => (row === false ? [] : [`${tableIds}-${row}`]))
  const shared = tables.length > 1 ? { tableShown: tablesShown } : {}

  return (
    <Card span={12} label={label}>
      <div className="workout-through">
        {hasTrace && (
          <>
            <div className="workout-through-head" id={headId}>
              <span className="label">{t('activity.workout.page.through.heartRate')}</span>
              {summary !== null && <p className="workout-through-summary">{summary}</p>}
            </div>
            <div className="workout-through-chart">
              <BasisContext.Provider value={headId}>
                <IntradayHeartRate points={trace.points} reduction={trace.reduction}
                  label={t('activity.workout.trace.label')}
                  offsetMinutes={session.startOffsetMinutes}
                  startMs={session.startMs} endMs={session.endMs} axis="elapsed" xLabels={both === null}
                  spans={pauses.spans} eventMarks={pauses.marks} zoneBands={zoneBands}
                  tableId={`${tableIds}-heart`} {...shared} />
              </BasisContext.Provider>
            </div>
          </>
        )}
        {rate !== null && (
          <SeriesRow row={rate} label={t(`activity.workout.page.through.${rateKey}`)} chartLabel={t(`activity.workout.page.through.${rateKey}Chart`)}
            session={session} spans={pauses.spans} xLabels={cadence === null} tableId={`${tableIds}-${rateKey}`} shared={shared} />
        )}
        {cadence !== null && (
          <SeriesRow row={cadence} label={t('activity.workout.page.through.cadence')} chartLabel={t('activity.workout.page.through.cadenceChart')}
            session={session} spans={pauses.spans} xLabels tableId={`${tableIds}-cadence`} shared={shared} />
        )}
      </div>
      {tables.length > 1 && (
        <div className="workout-through-toggle">
          <button type="button" className="chart-table-toggle" aria-expanded={tablesShown} aria-controls={tables.join(' ')}
            aria-label={t(tablesShown ? 'charts.tableToggle.hideFor' : 'charts.tableToggle.showFor', { label })}
            onClick={() => setTablesShown((current) => !current)}>
            {t(tablesShown ? 'charts.tableToggle.hide' : 'charts.tableToggle.show')}
          </button>
        </div>
      )}
      {/* What the axis is, under the chart it describes, so the card's first line is its label. */}
      <p className="dash-caption">{basis}</p>
      {noteLine !== null && <p className="workout-through-note">{noteLine}</p>}
    </Card>
  )
}

/** One row under the heart rate: its name and average at the left, its chart on the shared axis. */
function SeriesRow({ row, label, chartLabel, session, spans, xLabels, tableId, shared }: {
  row: NonNullable<ReturnType<typeof useSeriesRow>>
  label: string
  chartLabel: string
  session: WorkoutSession
  spans: readonly { startMs: number, endMs: number }[]
  xLabels: boolean
  tableId: string
  shared: { tableShown?: boolean }
}) {
  const headId = useId()
  return (
    <>
      <div className="workout-through-head" id={headId}>
        <span className="label">{label}</span>
        {row.summary !== null && <p className="workout-through-summary">{row.summary}</p>}
      </div>
      <div className="workout-through-chart">
        <BasisContext.Provider value={headId}>
          <IntradayHeartRate points={row.points} reduction={null} label={chartLabel}
            offsetMinutes={session.startOffsetMinutes} startMs={session.startMs} endMs={session.endMs} axis="elapsed"
            spans={spans} single={row.single} xLabels={xLabels} height={SERIES_HEIGHT} tableId={tableId} {...shared} />
        </BasisContext.Provider>
      </div>
    </>
  )
}
