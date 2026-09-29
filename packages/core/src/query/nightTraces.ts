// One intraday metric across one night: its lowest and highest reading and the night's mean, and
// the lowest and the mean as page figures, each judged against the same statistic over the nights
// before. The usual range reads every earlier night's window, one intradayWindow call each;
// NIGHT_TRACE_BANDS is the switch the measurement in the plan sets, and with it off no history is
// read and the figures carry no band (and so no verdict) rather than one faked from the whole-day
// figures. The line's usual band is `meanFigure.baseline`, not a second field beside it.
//
// **Unthinned, and both derived numbers below depend on that.** `intradayWindow` thins to a
// caller-supplied point budget with `thinBand`, whose minmax bucketing keeps each bucket's
// extremes - so a mean taken over a thinned series is biased toward those extremes and moves with
// the budget rather than with the night (#191, CONTRIBUTING.md "A reader that feeds a number says
// what it honours"). `query/sessionHeartRate.ts` hits the same defect over the same reader and is
// the earlier worked example; this reader asks for the same NO_THINNING-sized budget and gets the
// stored series back untouched, so `lowest`/`highest` are the night's real extremes and `mean` is
// its real mean, not an artifact of `TRACE_POINTS`.
//
// **Honours both override actions.** `intradayWindow` applies `exclude` and `correct` sample
// overrides itself before this reader sees a point, so both are inherited automatically: an
// excluded reading never contributes to the extremes or the mean, and a corrected one contributes
// its corrected value.
import { figureFromValues } from './pageFigure.ts'
import type { PageFigure } from './pageFigure.ts'
import { BASELINE_MIN_DAYS } from './baseline.ts'
import { INTRADAY_WINDOW_MAX_MS } from './intraday.ts'
import { METRICS } from '../derive/metrics.ts'
import type { PersonQuery } from './personQuery.ts'
import type { Night } from './sleepNights.ts'

export const NIGHT_TRACE_BANDS = true
// Larger than any night can hold readings for, so intradayWindow's thinning takes its "nothing to
// do" branch and hands back the stored series unchanged. See `query/sessionHeartRate.ts`'s own
// `NO_THINNING`, the same constant for the same reason.
const NO_THINNING = 1_000_000

export interface Extreme { value: number, atMs: number }
export interface NightTraceStat { lowest: Extreme | null, highest: Extreme | null, mean: number | null }
export interface NightTrace { metric: string, stat: NightTraceStat, lowestFigure: PageFigure, meanFigure: PageFigure }

const EMPTY: NightTraceStat = { lowest: null, highest: null, mean: null }

export function nightTraceStat(q: PersonQuery, metric: string, night: Pick<Night, 'startMs' | 'endMs'>): NightTraceStat {
  // A night is a sleep session's span, and a malformed one can outrun the window's cap, where
  // intradayWindow throws. One such night in the history would then fail every night page within
  // sixty days of it; skipped, it has no trace and adds nothing to anyone's usual, as the workout
  // page's highest heart rate skips an over-long session.
  if (night.endMs - night.startMs > INTRADAY_WINDOW_MAX_MS) return EMPTY
  const points = q.intradayWindow({ metric, startMs: night.startMs, endMs: night.endMs, points: NO_THINNING }).points
    .filter((p) => !p.excluded)
  let lowest: Extreme | null = null
  let highest: Extreme | null = null
  let sum = 0
  let n = 0
  for (const p of points) {
    if (p.min !== null && (lowest === null || p.min < lowest.value)) lowest = { value: p.min, atMs: p.utcMs }
    if (p.max !== null && (highest === null || p.max > highest.value)) highest = { value: p.max, atMs: p.utcMs }
    // n is a real reading count per point (intraday.ts's own comment on IntradayPoint.n), so the
    // night's mean is weighted by how many readings each point actually combines rather than
    // treating every point as equally many readings.
    if (p.mean !== null) { sum += p.mean * p.n; n += p.n }
  }
  return { lowest, highest, mean: n === 0 ? null : sum / n }
}

/**
 * Each history night's stat, in the history's order, or none while NIGHT_TRACE_BANDS is off. A
 * caller that needs the same stats for a figure of its own (the night page's heart-rate dip) reads
 * them here once and hands them to nightTrace, so no night's window is read twice.
 */
export function nightTraceHistory(q: PersonQuery, metric: string, history: readonly Night[]): NightTraceStat[] {
  return NIGHT_TRACE_BANDS ? history.map((n) => nightTraceStat(q, metric, n)) : []
}

export function nightTrace(
  q: PersonQuery, metric: string, night: Night, history: readonly Night[],
  earlier: readonly NightTraceStat[] = nightTraceHistory(q, metric, history),
): NightTrace {
  const stat = nightTraceStat(q, metric, night)
  const spec = METRICS[metric]
  // The trace metric's own catalogue entry says which way is better: a lower night-time heart rate,
  // a higher HRV and SpO2.
  const figure = (value: number | null, values: number[]) => figureFromValues({
    metric, unit: spec?.unit ?? '', precision: spec?.precision ?? 0, direction: spec?.direction ?? 'neutral',
    value, history: values, minN: BASELINE_MIN_DAYS,
  })
  return {
    metric,
    stat,
    lowestFigure: figure(stat.lowest?.value ?? null, earlier.flatMap((s) => (s.lowest === null ? [] : [s.lowest.value]))),
    meanFigure: figure(stat.mean, earlier.flatMap((s) => (s.mean === null ? [] : [s.mean]))),
  }
}
