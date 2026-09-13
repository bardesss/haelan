import type { WorkoutSplit } from './workoutSummary.ts'
import type { MinuteBpm } from './cardioLoad.ts'

/**
 * A split's heart rate, filled from the session's own trace when the device did not send one.
 *
 * `autoSplits[].averageHeartRateBpm` reads `metricsSummary.averageHeartRateBeatsPerMinute` from the
 * provider blob. Measured on one archived run on 2026-09-12 (Fish Potato Run, session
 * 5e9a366953be3ecd66bcceb6974143f3): every split had null, while the same call answered a dense
 * heart rate trace over the session's span. The number was recorded; it just was not written onto
 * the splits.
 *
 * Its own module rather than an addition to workoutSummary.ts: that file's opening line claims to
 * be the only module allowed to OPEN a session's attrs blob, and this function opens nothing - it
 * takes splits already decoded and a trace the decoder knows nothing about. Putting it there would
 * quietly widen a rule stated precisely.
 *
 * **The trace must be the unthinned one** (query/sessionHeartRate.ts). A mean taken over a thinned
 * band is biased toward each bucket's extremes and moves with the caller's point budget, and a
 * kilometre's heart rate may not depend on how many points a chart asked for.
 */
export interface FilledSplit extends WorkoutSplit {
  /**
   * Where `averageHeartRateBpm` came from, null when it is still absent.
   *
   * A filled cell and a cell the watch sent are different claims about a kilometre. Rendering them
   * identically would make the weaker one look like the stronger one, which is the whole reason
   * this field exists rather than the fill happening silently.
   */
  averageHeartRateBpmSource: 'provider' | 'trace' | null
}

export function fillSplitHeartRate(
  splits: readonly WorkoutSplit[],
  minutes: readonly MinuteBpm[],
): FilledSplit[] {
  return splits.map((split) => {
    // A recorded zero is a provider value, not an absence. `!== null` rather than a truthiness
    // test, the same discipline workoutSummary.ts states at length.
    if (split.averageHeartRateBpm !== null) {
      return { ...split, averageHeartRateBpmSource: 'provider' as const }
    }
    if (split.startMs === null || split.endMs === null) {
      return { ...split, averageHeartRateBpmSource: null }
    }
    // Half-open [start, end), so a point landing exactly on a boundary belongs to one split rather
    // than being counted into both.
    const inside = minutes.filter((m) => m.utcMs >= split.startMs! && m.utcMs < split.endMs!)
    // Null, never the session average. That is a number about the run and not about this
    // kilometre, and printing it here would be inventing one - the thing #169 asked us not to do.
    if (inside.length === 0) return { ...split, averageHeartRateBpmSource: null }
    const mean = inside.reduce((total, m) => total + m.bpm, 0) / inside.length
    return {
      ...split,
      averageHeartRateBpm: Math.round(mean),
      averageHeartRateBpmSource: 'trace' as const,
    }
  })
}
