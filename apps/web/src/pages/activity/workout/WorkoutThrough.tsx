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
import type { WorkoutSession } from '../../../data/useSessions.js'
import type { WorkoutPageData } from '../../../data/useWorkoutPage.js'
import type { Translate } from '../../../format.js'
import { formatFigureValue } from '../../detail/figureText.js'
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
 * Through the workout (M10a-3): the heart rate on the workout's own clock, 0:00 to its end, with
 * the zones as bands behind it and its pauses shaded. The approved mockup also draws pace and
 * cadence under it on the same axis; neither is drawn, because the archive has no per-minute
 * series for either: `steps` and `distance` are stored raw as provider intervals of their own
 * lengths (catalogue.ts: not downsampled to the minute, unlike heart rate), and /intraday/window
 * hands back each interval's start and no length, so a rate per minute cannot be read off it
 * without a new core read.
 *
 * Pinned to the device that recorded the workout unless it logged nothing, as WorkoutTrace was
 * (useSourceTrace's own rule), and the line under the chart says so when the fallback fired.
 * A pause with both ends is shaded; one with no end after it stays a mark (pausesOf).
 */
export function WorkoutThrough({ session, detail, page, chosenSource }: {
  session: WorkoutSession
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
  const pauses = useMemo(() => pausesOf(detail.events), [detail.events])
  const zoneBands = useMemo(() => zoneBandsOf(page.zoneBounds, t), [page.zoneBounds, t])

  const label = t('activity.workout.page.through.label')
  if (trace.isError) {
    return <Card span={12} label={label}><ErrorState onRetry={() => trace.refetch()} error={trace.error} /></Card>
  }
  if (trace.isPending) return <Card span={12} label={label}><Loading /></Card>
  // Absent, not an empty chart: nobody recorded a heart rate in this window, fallback included.
  if (trace.points.length === 0) return null

  const pausedMs = pauses.spans.reduce((sum, span) => sum + span.endMs - span.startMs, 0)
  const basis = [
    t('activity.workout.page.through.basis', { end: formatElapsed(session.endMs - session.startMs) }),
    ...(pauses.spans.length === 0 ? [] : [t('activity.workout.page.through.pauses', { count: pauses.spans.length, duration: formatElapsed(pausedMs) })]),
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

  return (
    <Card span={12} label={label} basis={basis}>
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
              startMs={session.startMs} endMs={session.endMs} axis="elapsed"
              spans={pauses.spans} eventMarks={pauses.marks} zoneBands={zoneBands} />
          </BasisContext.Provider>
        </div>
      </div>
      {note !== null && <p className="workout-through-note">{note}</p>}
    </Card>
  )
}
