import { METRICS } from '@haelan/core/metrics'

// Round to whole minutes before splitting, not after: splitting first turns 419.6 into 6h and round(59.6)m ("6h 60m").
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes)
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`
}

// Wrapped into the day before splitting, and wrapped in the direction that survives a negative.
// A bed time is minutes from the local midnight of the date the night ENDED (see
// packages/core/src/derive/metrics.ts on sleep_bedtime_minutes: "an 23:30 bedtime is -30"), so
// negatives reach here as ordinary values rather than as mistakes. JavaScript's % keeps the sign
// of its left operand, which rendered -40 as "-1:-40"; the double modulo below reads it as 23:20,
// which is the clock time that minute actually names.
export function formatClock(minutesPastMidnight: number): string {
  const total = ((Math.round(minutesPastMidnight) % 1440) + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export type Tone = 'good' | 'bad' | 'neutral'
export type Delta = { text: string; dir: 'up' | 'down' | 'flat'; tone?: Tone; basis?: string }

// 'neutral' means the metric's polarity is genuinely ambiguous, not that no one bothered to state it.
export type Polarity = 'higher-is-better' | 'lower-is-better' | 'neutral'

export function toneFor(dir: Delta['dir'], polarity: Polarity): Tone {
  if (dir === 'flat' || polarity === 'neutral') return 'neutral'
  const goodDirection = polarity === 'higher-is-better' ? 'up' : 'down'
  return dir === goodDirection ? 'good' : 'bad'
}

export function toneOf(delta: Delta | undefined): Tone {
  return delta?.tone ?? 'neutral'
}

// The shape react-i18next's `t` actually has, kept local rather than importing i18next's own
// type surface for one parameter: format.ts has no JSX and no hook access, so the caller (a
// component) resolves `t` and hands it down.
export type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * Whether a metric's values are positions on a clock rather than quantities, so no percentage
 * change over them means anything.
 *
 * Read off the catalogue's own `unit` rather than a list kept here, because the catalogue is where
 * the fact lives and where the next such metric will be declared:
 * packages/core/src/derive/metrics.ts gives sleep_bedtime_minutes and sleep_waketime_minutes
 * `minutes_from_local_midnight` precisely to say this, in a comment that spells out the
 * consequence ("-30 is not thirty minutes of anything, it is thirty minutes before midnight").
 * trend() over that scale rendered a fortnight moving from 23:58 to 23:30, a person going to bed
 * earlier, as "up 1400%", and 00:10 moving to 23:50 as "down 200%".
 *
 * A predicate over the metric rather than an argument at the call site: the delta was first
 * suppressed by passing null for a positional `polarity`, which meant only the one helper that
 * grew the parameter could express it, the other three page helpers could not, and the next clock
 * scaled metric would take whatever a future call site typed. This is the shape MetricCard already
 * uses for the wear clause, where coverageIsWearSignal decides inside the component and no caller
 * is asked to know.
 */
export function metricIsClockOffset(metric: string): boolean {
  return METRICS[metric]?.unit === 'minutes_from_local_midnight'
}

/**
 * The delta a card should show for a metric, which for a clock offset is none.
 *
 * Every page tile goes through this rather than calling trend() directly, so the decision is made
 * once from the metric a card already names instead of once per page helper. trend() itself keeps
 * its narrower contract (a percentage over a list of numbers, no opinion about what they mean),
 * because that is what its own unit tests hold it to and it has no metric to consult.
 */
export function deltaFor(
  t: Translate, metric: string, values: number[], polarity: Polarity,
): Delta | undefined {
  if (metricIsClockOffset(metric)) return undefined
  return trend(t, values, polarity)
}

// Flat below 1% swing: smaller reads as noise, not a real trend.
//
// Undefined rather than a Delta whose text lies: a series with fewer than two points (the "day"
// range yields exactly one) hands slice() an empty first half, and 0 reduced over nothing divided
// by a length of zero is NaN before either mean is even compared. A series whose first half
// legitimately averages to zero (a real reading, not a gap, for a metric like
// sleep_asleep_minutes on a night with no sleep) divides by that zero instead and produces
// Infinity. Both are "no percentage exists to report" rather than two different bugs, so one
// finite check after computing pct catches both without special-casing either.
export function trend(t: Translate, values: number[], polarity: Polarity = 'neutral'): Delta | undefined {
  const half = Math.floor(values.length / 2)
  const first = values.slice(0, half)
  const second = values.slice(half)
  const meanFirst = first.reduce((sum, v) => sum + v, 0) / first.length
  const meanSecond = second.reduce((sum, v) => sum + v, 0) / second.length
  const pct = ((meanSecond - meanFirst) / meanFirst) * 100
  if (!Number.isFinite(pct)) return undefined
  const dir: Delta['dir'] = Math.abs(pct) < 1 ? 'flat' : pct > 0 ? 'up' : 'down'
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→'
  return {
    text: `${arrow} ${Math.abs(pct).toFixed(0)}%`,
    dir,
    tone: toneFor(dir, polarity),
    basis: t('common.trendBasis', { recent: second.length, earlier: first.length }),
  }
}
