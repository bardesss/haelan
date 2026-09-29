import { useId, useMemo } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { BasisContext } from '../../components/basis.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { IntradayHeartRate, intradayBasis } from '../../charts/IntradayHeartRate.js'
import { useSourceTrace } from '../../data/useSourceTrace.js'
import { useSourceNames } from '../../data/useSourceNames.js'
import type { Night } from '../../data/useNights.js'
import type { NightTrace as NightTraceFigures } from '../../data/useNightPage.js'
import { formatRecordedClock } from '../../format.js'
import { formatFigureValue } from '../detail/figureText.js'

/**
 * The three metrics the night page charts across the night's own window, in the approved mockup's
 * order. Confirmed against packages/core/src/derive/metrics.ts's own spellings rather than
 * guessed: 'spo2' and 'hrv' are both real catalogue entries, not 'blood_oxygen' or
 * 'heart_rate_variability'.
 */
export const NIGHT_TRACE_METRICS = ['heart_rate', 'hrv', 'spo2'] as const
type TraceMetric = typeof NIGHT_TRACE_METRICS[number]

/**
 * What the server made of each trace (the night page's `traces`, keyed by metric id here): the
 * night's extremes and its mean, each already judged against its usual.
 */
export type NightTracesFigures = Partial<Record<TraceMetric, NightTraceFigures>>

type Trace = ReturnType<typeof useSourceTrace>

/**
 * The usual range of the night's mean, the band shaded behind a trace; none on a thin baseline,
 * which would draw three nights' worth of history as confidently as sixty.
 */
function usualBandOf(figures: NightTraceFigures | undefined): { low: number, high: number } | undefined {
  const baseline = figures?.meanFigure.baseline ?? null
  return baseline !== null && !baseline.thin ? { low: baseline.low, high: baseline.high } : undefined
}

/** A row with nothing recorded draws nothing (NightTraceRow's own rule). */
const drawsNothing = (trace: Trace) => !trace.isError && !trace.isPending && trace.points.length === 0

/**
 * One metric's row: a short label and the night's extreme in words on the left, the trace beside
 * it. A row, not a card: the three sit inside the night card under the hypnogram, over the same
 * span, the approved mockup's layout.
 *
 * The extreme is the night's lowest heart rate and blood oxygen and its highest HRV, the end of
 * each that says the most about a night, at the night's own offset (the clock the chart reads).
 * The chart's accessible description is the row's own label and summary, published the way a
 * card publishes its basis line, since a row has no basis line of its own.
 */
function NightTraceRow({ metric, trace, night, figures }: {
  metric: TraceMetric
  trace: Trace
  night: Night
  figures: NightTraceFigures | undefined
}) {
  const { t, i18n } = useTranslation()
  const headId = useId()
  const label = t(`sleep.night.traces.${metric}`)
  // The row keeps the mockup's short "HRV"; the chart's own name says which HRV it is, since the
  // morning card further down draws another.
  const chartLabel = metric === 'hrv' ? t('sleep.night.traces.hrvChart') : label
  // Memoised on the payload's own figures: the chart rebuilds whenever the band's reference changes.
  const usualBand = useMemo(() => usualBandOf(figures), [figures])

  // Absent, not an empty chart: nobody recorded this metric in this window, and the fallback has
  // already been tried (useSourceTrace's own rule), so there is nothing to draw and no claim to
  // make about it beyond the row not being there.
  if (drawsNothing(trace)) return null

  const highest = metric === 'hrv'
  const extreme = figures === undefined ? null : highest ? figures.stat.highest : figures.stat.lowest
  const summary = figures === undefined || extreme === null ? null : t(
    highest ? 'sleep.night.traces.highest' : 'sleep.night.traces.lowest',
    {
      value: formatFigureValue(figures.lowestFigure, extreme.value, i18n.language, t),
      time: formatRecordedClock(extreme.atMs, night.startOffsetMinutes),
    },
  )

  return (
    <div className="night-trace">
      <div className="night-trace-head" id={headId}>
        <span className="label">{label}</span>
        {summary !== null && <p className="night-trace-summary">{summary}</p>}
      </div>
      <div className="night-trace-chart">
        {trace.isError ? <ErrorState onRetry={() => trace.refetch()} error={trace.error} />
          : trace.isPending ? <Loading />
          : (
            <BasisContext.Provider value={headId}>
              {/* Compact, bounded to the night itself rather than to the readings inside it, so the
                  three rows share one span with each other and with the stages above. */}
              <IntradayHeartRate points={trace.points} reduction={trace.reduction} label={chartLabel} metric={metric}
                compact offsetMinutes={night.startOffsetMinutes} startMs={night.startMs} endMs={night.endMs}
                usualBand={usualBand} />
            </BasisContext.Provider>
          )}
      </div>
    </div>
  )
}

/**
 * The night's heart rate, HRV and blood oxygen, each across the night's own span and each pinned to
 * the device that recorded the night unless that device logged nothing: `sessionSourceId` is
 * `night.sourceId`, the role a workout session's own sourceId plays for WorkoutTrace.tsx, and
 * useSourceTrace's fallback rule (measured 189 own device only, 2 both, 5 another device only, 2
 * neither, of 198 exercise sessions) applies unchanged.
 *
 * Three literal useSourceTrace calls rather than a loop over NIGHT_TRACE_METRICS: a hook cannot be
 * called a variable number of times, and holding the three reads here, rather than one per row,
 * lets the one line under the rows name every trace that fell back. Nothing at the type level keeps
 * the calls and the constant in step; night-traces.test.tsx's row count, checked against
 * NIGHT_TRACE_METRICS.length, catches a metric added to one without the other.
 */
export function NightTraces({ night, chosenSource, traces }: {
  night: Night
  chosenSource: string | null
  /** The night page's own figures for each trace; without them a row is its label and chart. */
  traces?: NightTracesFigures
}) {
  const { t } = useTranslation()
  const { nameOf } = useSourceNames()
  const span = { startMs: night.startMs, endMs: night.endMs, sessionSourceId: night.sourceId, chosenSource }
  const reads: [TraceMetric, Trace][] = [
    ['heart_rate', useSourceTrace({ metric: 'heart_rate', ...span })],
    ['hrv', useSourceTrace({ metric: 'hrv', ...span })],
    ['spo2', useSourceTrace({ metric: 'spo2', ...span })],
  ]

  // Nothing at all, caption included, once every read has settled on nothing recorded.
  if (reads.every(([, trace]) => drawsNothing(trace))) return null
  // The caption explains the shaded band, so it is there only when a drawn row shades one.
  const anyBand = reads.some(([metric, trace]) => !drawsNothing(trace) && usualBandOf(traces?.[metric]) !== undefined)

  // A trace that fell back says so, naming the device that logged nothing and the metric in words
  // (sleep.night.traces.metricNames), the same sentence the workout page words the same case in.
  const fellBack = reads
    .filter(([, trace]) => trace.traceSource === 'otherSources' && trace.points.length > 0)
    .map(([metric, trace]) => t('sleep.night.traces.basisFellBack', {
      pinned: nameOf(trace.pinnedSourceId),
      metric: t(`sleep.night.traces.metricNames.${metric}`),
      detail: intradayBasis(t, trace.reduction, trace.points.length),
    }))

  return (
    <div className="night-traces">
      {reads.map(([metric, trace]) => (
        <NightTraceRow key={metric} metric={metric} trace={trace} night={night} figures={traces?.[metric]} />
      ))}
      {fellBack.length > 0 && <p className="night-traces-basis">{fellBack.join(' ')}</p>}
      {anyBand && <p className="dash-caption">{t('sleep.night.traces.caption')}</p>}
    </div>
  )
}
