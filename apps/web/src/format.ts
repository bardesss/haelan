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
