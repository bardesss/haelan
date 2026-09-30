import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
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
import type { MinuteSeries, WorkoutFigure, WorkoutPageData } from '../../../data/useWorkoutPage.js'
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
 * One series row's chart settings and words, memoised on the series: `single` reaches the chart's
 * build, and a fresh one every render would rebuild it. The average is the page's own figure for
 * the workout (the server's), never worked out from the series.
 */
function useSeriesRow(series: MinuteSeries | null, average: WorkoutFigure | undefined, key: 'pace' | 'cadence', startMs: number, sourceId: string) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  return useMemo(() => {
    if (series === null) return null
    const figure = { metric: key, value: null, unit: series.unit, precision: 0 }
    const averageText = average === undefined || average.value === null ? null : formatFigureValue(average, average.value, language, t)
    return {
      points: minutePoints(series, startMs, sourceId),
      single: {
        column: t(`activity.workout.page.through.${key}`),
        formatValue: (value: number) => formatFigureValue(figure, value, language, t),
        formatAxis: key === 'pace' ? formatStopwatch : (value: number) => formatFigureValue({ ...figure, unit: 'count' }, value, language, t),
        inverse: key === 'pace',
        ...(average !== undefined && average.value !== null && averageText !== null && {
          reference: { value: average.value, label: t('activity.workout.page.through.averageShort', { value: averageText }) },
        }),
      },
      summary: averageText === null ? null : t('activity.workout.page.through.average', { value: averageText }),
    }
  }, [series, average, key, startMs, sourceId, language, t])
}

/**
 * Through the workout (M10a-3): the heart rate on the workout's own clock, 0:00 to its end, with
 * the zones as bands behind it and its pauses shaded. Under it, on the same axis (M10b), the pace
 * and the cadence a minute at a time as the server reads them (`page.through`), each smoothed over
 * three minutes and each with the workout's own average as a dashed line. Pace is drawn upside
 * down, since a faster minute is a smaller number, and comes from the route's own timestamps, so
 * a workout without a route has none. Cadence comes from the steps the workout's own device
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
  const trace = useSourceTrace({
    metric: 'heart_rate', startMs: session.startMs, endMs: session.endMs,
    sessionSourceId: session.sourceId, chosenSource,
  })
  // Memoised: each reaches the chart's build, and a fresh reference every render rebuilds it.
  const pauses = useMemo(() => pausesOf(detail.events, session.endMs), [detail.events, session.endMs])
  const zoneBands = useMemo(() => zoneBandsOf(page.zoneBounds, t), [page.zoneBounds, t])
  const pace = useSeriesRow(page.through.pace, page.figures.pace, 'pace', session.startMs, session.sourceId)
  const cadence = useSeriesRow(page.through.cadence, page.figures.cadence, 'cadence', session.startMs, session.sourceId)

  const label = t('activity.workout.page.through.label')
  if (trace.isError) {
    return <Card span={12} label={label}><ErrorState onRetry={() => trace.refetch()} error={trace.error} /></Card>
  }
  if (trace.isPending) return <Card span={12} label={label}><Loading /></Card>
  // Absent, not an empty chart: nobody recorded a heart rate in this window, fallback included.
  if (trace.points.length === 0) return null

  // Which of the two series is drawn, as the catalogue names the case.
  const both = pace === null && cadence === null ? null : pace === null ? 'cadence' : cadence === null ? 'pace' : 'both'
  const pausedMs = pauses.spans.reduce((sum, span) => sum + span.endMs - span.startMs, 0)
  const basis = [
    t('activity.workout.page.through.basis', { end: formatElapsed(session.endMs - session.startMs) }),
    ...(pauses.spans.length === 0 ? [] : [t('activity.workout.page.through.pauses', { count: pauses.spans.length, duration: formatElapsed(pausedMs) })]),
    ...(both === null ? [] : [t(`activity.workout.page.through.smoothed.${both}`)]),
    // Only a workout that covers a distance has a pace to miss.
    ...(pace === null && page.figures.distance !== undefined ? [t('activity.workout.page.through.noRoute')] : []),
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
  const routePoints = (session.route as WorkoutSessionDetail['route'] | undefined)?.length ?? 0
  const seriesFrom = both === null ? null
    : t(`activity.workout.page.through.${note === null ? 'from' : 'fromAfter'}.${both}`, { count: routePoints })
  const noteLine = note === null ? seriesFrom : seriesFrom === null ? note : `${note}; ${seriesFrom}`

  return (
    <Card span={12} label={label}>
      <div className="workout-through">
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
              spans={pauses.spans} eventMarks={pauses.marks} zoneBands={zoneBands} />
          </BasisContext.Provider>
        </div>
        {pace !== null && (
          <SeriesRow row={pace} label={t('activity.workout.page.through.pace')} chartLabel={t('activity.workout.page.through.paceChart')}
            session={session} spans={pauses.spans} xLabels={cadence === null} />
        )}
        {cadence !== null && (
          <SeriesRow row={cadence} label={t('activity.workout.page.through.cadence')} chartLabel={t('activity.workout.page.through.cadenceChart')}
            session={session} spans={pauses.spans} xLabels />
        )}
      </div>
      {/* What the axis is, under the chart it describes, so the card's first line is its label. */}
      <p className="dash-caption">{basis}</p>
      {noteLine !== null && <p className="workout-through-note">{noteLine}</p>}
    </Card>
  )
}

/** One row under the heart rate: its name and average at the left, its chart on the shared axis. */
function SeriesRow({ row, label, chartLabel, session, spans, xLabels }: {
  row: NonNullable<ReturnType<typeof useSeriesRow>>
  label: string
  chartLabel: string
  session: WorkoutSession
  spans: readonly { startMs: number, endMs: number }[]
  xLabels: boolean
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
            spans={spans} single={row.single} xLabels={xLabels} height={SERIES_HEIGHT} />
        </BasisContext.Provider>
      </div>
    </>
  )
}
