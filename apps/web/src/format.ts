// Shared display helpers for the reference pages. Kept here instead of inline
// so Dashboard and Sleep format the same fields the same way.

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return `${h}h ${String(m).padStart(2, '0')}m`
}

export function formatClock(minutesPastMidnight: number): string {
  const wrapped = Math.floor(minutesPastMidnight / 60) % 24
  const mins = Math.round(minutesPastMidnight % 60)
  return `${String(wrapped).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

export type Tone = 'good' | 'bad' | 'neutral'
export type Delta = { text: string; dir: 'up' | 'down' | 'flat'; tone?: Tone }

// Direction is a fact read off the data; tone is a judgement about whether
// that direction is good news, and the two must stay separable. A caller
// states which way is good for its own metric; 'neutral' means the metric's
// polarity is genuinely ambiguous (a rising daily mean heart rate, say) and
// no colour should assert an opinion the code was never given.
export type Polarity = 'higher-is-better' | 'lower-is-better' | 'neutral'

function toneFor(dir: Delta['dir'], polarity: Polarity): Tone {
  if (dir === 'flat' || polarity === 'neutral') return 'neutral'
  const goodDirection = polarity === 'higher-is-better' ? 'up' : 'down'
  return dir === goodDirection ? 'good' : 'bad'
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
  return { text: `${arrow} ${Math.abs(pct).toFixed(0)}%`, dir, tone: toneFor(dir, polarity) }
}
