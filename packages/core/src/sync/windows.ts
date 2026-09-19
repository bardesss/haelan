import { ConfigError } from '../errors.ts'
import { localDateOf } from './localDate.ts'

export interface Window { startMs: number, endMs: number, localDate: string }

const MAX_WINDOWS = 4000
const HOUR_MS = 3_600_000

// Walking back an hour at a time from a known instant inside the day, until the local date
// changes, finds local midnight without needing the offset. That matters because the offset is
// not constant: a DST day is 23 or 25 hours long, and a fixed 24 hour step would drift.
export function startOfLocalDay(ms: number, timeZone: string): number {
  // Local midnight is always minute aligned, since no IANA zone has a sub-minute offset, so
  // flooring the seed onto the absolute minute grid first keeps every probe on that grid too.
  // Without this, a seed carrying a sub-minute residue (Date.now() is never exactly :00.000)
  // would return midnight plus that residue, and two calls landing in the same local day at
  // different instants would then produce different results, defeating the archive's
  // day-aligned dedup key. Flooring never moves the seed into the previous local day, because
  // the day boundary is itself minute aligned.
  const seed = Math.floor(ms / 60_000) * 60_000
  const target = localDateOf(seed, timeZone)
  let probe = seed
  while (localDateOf(probe - HOUR_MS, timeZone) === target) probe -= HOUR_MS
  // The hour containing the boundary is then bisected to the minute, which is enough: no zone
  // in the IANA database has an offset that is not a whole number of minutes.
  let lo = probe - HOUR_MS
  let hi = probe
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000
    if (mid === lo) break
    if (localDateOf(mid, timeZone) === target) hi = mid
    else lo = mid
  }
  return hi
}

export function dayWindows(input: { fromMs: number, toMs: number, timezone: string }): Window[] {
  if (input.toMs <= input.fromMs) return []
  const days = (input.toMs - input.fromMs) / 86_400_000
  if (days > MAX_WINDOWS) throw new ConfigError(`window span of ${Math.round(days)} days exceeds ${MAX_WINDOWS}`)

  const windows: Window[] = []
  let cursor = startOfLocalDay(input.fromMs, input.timezone)
  while (cursor < input.toMs) {
    const localDate = localDateOf(cursor, input.timezone)
    // Stepping 25 hours and re-aligning lands inside the next local day on every DST case,
    // where a fixed 24 hour step would land back inside the same day in autumn.
    const next = startOfLocalDay(cursor + 25 * HOUR_MS, input.timezone)
    windows.push({ startMs: cursor, endMs: next, localDate })
    cursor = next
  }
  return windows
}
