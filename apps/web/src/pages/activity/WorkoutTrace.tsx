import { useMemo } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { IntradayHeartRate, intradayBasis } from '../../charts/IntradayHeartRate.js'
import { useSourceTrace } from '../../data/useSourceTrace.js'
import { useSourceNames } from '../../data/useSourceNames.js'
import type { WorkoutDetail } from '@haelan/core/workout-summary'
import type { WorkoutSession } from '../../data/useSessions.js'

const TRACE_METRIC = 'heart_rate'
/** The only event type this archive has ever held mid-session; the decoder still reads every type
 *  the v4 schema allows, because another device may write one. */
const PAUSE = 'PAUSE'

/**
 * The workout's heart rate trace, pinned to the device that recorded the workout unless that
 * device logged nothing in the window (useSourceTrace's own comment measures and justifies the
 * fallback rule) - plus a marker at each PAUSE instant, never shading, since the archive supplies
 * one end of a pause and never the other (IntradayHeartRate's own comment on eventMarks).
 */
export function WorkoutTrace({ session, detail, chosenSource }: {
  session: WorkoutSession
  detail: WorkoutDetail
  chosenSource: string | null
}) {
  const { t } = useTranslation()
  const { nameOf } = useSourceNames()
  const trace = useSourceTrace({
    metric: TRACE_METRIC, startMs: session.startMs, endMs: session.endMs,
    sessionSourceId: session.sourceId, chosenSource,
  })

  // Memoised on detail.events, not rebuilt as a fresh array on every render: this feeds
  // IntradayHeartRate's own `eventMarks` prop, which sits in that chart's `build` useCallback
  // deps, which useChart keys its init/dispose effect on (useChart.ts's own comment on `build`) -
  // a fresh `filter().map()` here disposed and reinitialised the chart on every commit regardless
  // of whether the events actually changed. Final review finding; the same defect NO_EVENT_MARKS
  // in IntradayHeartRate.tsx exists to prevent for the no-marks caller, reintroduced by the one
  // caller that passes marks.
  const marks = useMemo(
    () => detail.events
      .filter((event) => event.kind === PAUSE && event.atMs !== null)
      .map((event) => ({ atMs: event.atMs! })),
    [detail.events],
  )

  if (trace.isError) {
    return <Card span={12} label={t('activity.workout.trace.label')}>
      <ErrorState onRetry={() => trace.refetch()} /></Card>
  }
  if (trace.isPending) {
    return <Card span={12} label={t('activity.workout.trace.label')}><Loading /></Card>
  }
  // Absent, not an empty chart: nobody recorded a heart rate in this window, and the fallback has
  // already been tried (useSourceTrace's own rule), so there is nothing to draw and no claim to
  // make about it beyond the card not being there.
  if (trace.points.length === 0) return null

  // When the fallback fired, the basis says so and names both devices. A trace from a device other
  // than the one that recorded the workout is a fact about the reading, not a detail to smooth over.
  const basis = trace.traceSource === 'otherSources'
    ? t('activity.workout.trace.basisFellBack', {
      pinned: nameOf(trace.pinnedSourceId),
      detail: intradayBasis(t, trace.reduction, trace.points.length),
    })
    : intradayBasis(t, trace.reduction, trace.points.length)

  return (
    <Card span={12} label={t('activity.workout.trace.label')} basis={basis}>
      <IntradayHeartRate
        points={trace.points}
        reduction={trace.reduction}
        label={t('activity.workout.trace.label')}
        eventMarks={marks}
      />
    </Card>
  )
}
