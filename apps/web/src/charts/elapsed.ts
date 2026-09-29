// Time into a session, for an axis that must read the same whether the run started at 18:00 or
// crossed midnight: 5:00, 28:04, 1:05:05.
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
// Steps a stopwatch reader counts in; past an hour, whole hours.
const STEPS_MS = [1, 2, 5, 10, 15, 30, 60].map((minutes) => minutes * MINUTE_MS)
// Seven steps across a card at most: 0:00 to 35:00 in fives, the approved mockup's run.
const MAX_STEPS = 7

/**
 * The tick step for an elapsed axis `spanMs` long: the smallest of 1, 2, 5, 10, 15, 30 or 60
 * minutes that fits the span in seven steps or fewer, else the fewest whole hours that do. Every
 * tick then lands on a whole step from the start (0:00, 5:00, 10:00), never on a clock boundary
 * that happens to fall a few minutes into the session.
 */
export function elapsedInterval(spanMs: number): number {
  const span = Math.max(0, spanMs)
  const step = STEPS_MS.find((candidate) => span / candidate <= MAX_STEPS)
  return step ?? Math.ceil(span / MAX_STEPS / HOUR_MS) * HOUR_MS
}
