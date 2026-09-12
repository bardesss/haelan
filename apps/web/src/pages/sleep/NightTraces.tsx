import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { IntradayHeartRate, intradayBasis } from '../../charts/IntradayHeartRate.js'
import { useSourceTrace } from '../../data/useSourceTrace.js'
import { useSourceNames } from '../../data/useSourceNames.js'
import type { Night } from '../../data/useNights.js'

/**
 * The three metrics the night detail page charts across the night's own window, section 4's
 * "Overnight traces" paragraph. Confirmed against packages/core/src/derive/metrics.ts's own
 * spellings rather than guessed: 'spo2' and 'hrv' are both real catalogue entries, not
 * 'blood_oxygen' or 'heart_rate_variability'.
 */
export const NIGHT_TRACE_METRICS: readonly string[] = ['heart_rate', 'spo2', 'hrv']

/**
 * One metric's card: a single useSourceTrace call, pinned to the night's own source, over the
 * night's own window rather than its local date - the case section 2.2 exists for, since a night
 * can run from 23:15 to 07:02 and a date-keyed read cannot express that span. `sessionSourceId` is
 * `night.sourceId`, exactly the same role a workout session's own sourceId plays for
 * WorkoutTrace.tsx: a Night is assembled per (localDate, sourceId), so its own source is exactly as
 * capable of having recorded nothing as a workout's is, and useSourceTrace's fallback rule
 * (measured 189 own device only, 2 both, 5 another device only, 2 neither, of 198 exercise
 * sessions) applies unchanged.
 *
 * A component of its own, not a body inlined in a loop inside NightTraces: React's rules forbid
 * calling a hook a variable number of times, and NIGHT_TRACE_METRICS is a list, so each metric
 * needs its own component instance to make its own single call. That also keeps each card's
 * absence independent - one metric finding nothing does not affect whether another renders.
 */
function NightTrace({ metric, night, chosenSource }: {
  metric: string
  night: Night
  chosenSource: string | null
}) {
  const { t } = useTranslation()
  const { nameOf } = useSourceNames()
  const trace = useSourceTrace({
    metric, startMs: night.startMs, endMs: night.endMs,
    sessionSourceId: night.sourceId, chosenSource,
  })
  const label = t(`sleep.night.traces.${metric}`)

  if (trace.isError) {
    return (
      <div className="night-trace">
        <Card span={12} label={label}><ErrorState onRetry={() => trace.refetch()} /></Card>
      </div>
    )
  }
  if (trace.isPending) {
    return <div className="night-trace"><Card span={12} label={label}><Loading /></Card></div>
  }
  // Absent, not an empty chart: nobody recorded this metric in this window, and the fallback has
  // already been tried (useSourceTrace's own rule), so there is nothing to draw and no claim to
  // make about it beyond the card not being there - the same rule WorkoutTrace.tsx applies to its
  // own single metric, generalised to the three this page charts.
  if (trace.points.length === 0) return null

  // When the fallback fired, the basis says so and names both the pinned device (the one that
  // logged nothing) and the metric it was pinned for, since this card - unlike the workout page's
  // single-metric one - shares its basis sentence across three different metrics.
  const basis = trace.traceSource === 'otherSources'
    ? t('sleep.night.traces.basisFellBack', {
      pinned: nameOf(trace.pinnedSourceId),
      metric,
      detail: intradayBasis(t, trace.reduction, trace.points.length),
    })
    : intradayBasis(t, trace.reduction, trace.points.length)

  return (
    <div className="night-trace">
      <Card span={12} label={label} basis={basis}>
        <IntradayHeartRate points={trace.points} reduction={trace.reduction} label={label} />
      </Card>
    </div>
  )
}

/**
 * Section 4's "Overnight traces": heart rate, SpO2 and HRV, each across the night's own span and
 * each pinned to the device that recorded the night unless that device logged nothing (see
 * NightTrace's own comment on the rule it reuses from the workout page rather than reinventing).
 *
 * Rendered from NightDetail.tsx inside the page's own `.grid`, after the stages card - three
 * fragment children rather than one wrapping element, the same shape NightStages and NightTiles
 * already sit in that grid as.
 */
export function NightTraces({ night, chosenSource }: { night: Night, chosenSource: string | null }) {
  return (
    <>
      <NightTrace metric="heart_rate" night={night} chosenSource={chosenSource} />
      <NightTrace metric="spo2" night={night} chosenSource={chosenSource} />
      <NightTrace metric="hrv" night={night} chosenSource={chosenSource} />
    </>
  )
}
