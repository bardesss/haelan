// Shared display helpers for the reference pages. Kept here instead of inline
// so Dashboard and Sleep format the same fields the same way.

// Round to whole minutes before splitting, not after: splitting first turns
// 419.6 into 6h and round(59.6)m, which renders as "6h 60m".
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes)
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`
}

export function formatClock(minutesPastMidnight: number): string {
  const total = Math.round(minutesPastMidnight)
  const hours = Math.floor(total / 60) % 24
  return `${String(hours).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export type Tone = 'good' | 'bad' | 'neutral'
export type Delta = { text: string; dir: 'up' | 'down' | 'flat'; tone?: Tone; basis?: string }

// Direction is a fact read off the data; tone is a judgement about whether
// that direction is good news, and the two must stay separable. A caller
// states which way is good for its own metric; 'neutral' means the metric's
// polarity is genuinely ambiguous (a rising daily mean heart rate, say) and
// no colour should assert an opinion the code was never given.
export type Polarity = 'higher-is-better' | 'lower-is-better' | 'neutral'

export function toneFor(dir: Delta['dir'], polarity: Polarity): Tone {
  if (dir === 'flat' || polarity === 'neutral') return 'neutral'
  const goodDirection = polarity === 'higher-is-better' ? 'up' : 'down'
  return dir === goodDirection ? 'good' : 'bad'
}

// The one place that decides what colour an unstated tone gets. A delta nobody
// has claimed a polarity for is never coloured as if a judgement had been made.
export function toneOf(delta: Delta | undefined): Tone {
  return delta?.tone ?? 'neutral'
}

// Compares the mean of the first half of a run of worn-day values against the
// second half, so every delta on the page is read off the fixture rather than
// invented. Flat below 1% swing, since anything smaller reads as noise.
export function trend(values: number[], polarity: Polarity = 'neutral'): Delta {
  const half = Math.floor(values.length / 2)
  const first = values.slice(0, half)
  const second = values.slice(half)
  const meanFirst = first.reduce((sum, v) => sum + v, 0) / first.length
  const meanSecond = second.reduce((sum, v) => sum + v, 0) / second.length
  const pct = ((meanSecond - meanFirst) / meanFirst) * 100
  const dir: Delta['dir'] = Math.abs(pct) < 1 ? 'flat' : pct > 0 ? 'up' : 'down'
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→'
  return {
    text: `${arrow} ${Math.abs(pct).toFixed(0)}%`,
    dir,
    tone: toneFor(dir, polarity),
    basis: `change is the mean of the last ${second.length} readings against the first ${first.length}`,
  }
}
