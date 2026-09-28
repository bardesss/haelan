// One intraday metric across one night: its lowest and highest reading and the night's mean, and
// the usual range of those over the nights before. The usual range reads every earlier night's
// window, one intradayWindow call each; NIGHT_TRACE_BANDS is the switch the measurement in the plan
// sets, and with it off no history is read and the bands are absent rather than faked from the
// whole-day figures.
import { usualOf } from './pageFigure.ts'
import { BASELINE_MIN_DAYS } from './baseline.ts'
import type { GlanceBaseline } from './glance.ts'
import type { PersonQuery } from './personQuery.ts'
import type { Night } from './sleepNights.ts'

export const NIGHT_TRACE_BANDS = true
// Enough buckets that the thinned min and max are the real extremes of a seven-hour night.
const TRACE_POINTS = 240

export interface Extreme { value: number, atMs: number }
export interface NightTraceStat { lowest: Extreme | null, highest: Extreme | null, mean: number | null }
export interface NightTrace { metric: string, stat: NightTraceStat, usualMean: GlanceBaseline | null, usualLowest: GlanceBaseline | null }

export function nightTraceStat(q: PersonQuery, metric: string, night: Pick<Night, 'startMs' | 'endMs'>): NightTraceStat {
  const points = q.intradayWindow({ metric, startMs: night.startMs, endMs: night.endMs, points: TRACE_POINTS }).points
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

export function nightTrace(q: PersonQuery, metric: string, night: Night, history: readonly Night[]): NightTrace {
  const stat = nightTraceStat(q, metric, night)
  if (!NIGHT_TRACE_BANDS) return { metric, stat, usualMean: null, usualLowest: null }
  const earlier = history.map((n) => nightTraceStat(q, metric, n))
  const means = earlier.flatMap((s) => (s.mean === null ? [] : [s.mean]))
  const lows = earlier.flatMap((s) => (s.lowest === null ? [] : [s.lowest.value]))
  return { metric, stat, usualMean: usualOf(means, BASELINE_MIN_DAYS), usualLowest: usualOf(lows, BASELINE_MIN_DAYS) }
}
