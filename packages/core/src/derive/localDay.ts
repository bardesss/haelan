// The only place a day boundary is computed. Every row already carries the offset in force at
// its own instant, so nothing here consults a timezone database: guessing an offset from a date
// is exactly the mistake that puts a night on the wrong side of a daylight saving change.

const pad = (n: number): string => String(n).padStart(2, '0')

export function localDateOf(utcMs: number, tzOffsetMinutes: number): string {
  const shifted = new Date(utcMs + tzOffsetMinutes * 60_000)
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

export function localHourOf(utcMs: number, tzOffsetMinutes: number): number {
  return new Date(utcMs + tzOffsetMinutes * 60_000).getUTCHours()
}

const HOUR_MS = 3_600_000

/**
 * Widens a UTC scan enough to catch every instant that could fall on `localDate`, under any
 * offset the provider can report, UTC-12 to UTC+14. The exact per-row filter narrows this back
 * down by each row's own stored offset; widening first and filtering after reads the same rows
 * an unbounded scan would, only fewer of them. `deriveDayInto` and `readIntraday` both need
 * exactly this arithmetic, so it lives once here rather than twice: two copies are two chances
 * for the widened window to quietly stop agreeing with the filter that narrows it.
 */
export function widenedUtcWindow(localDate: string): { start: number, end: number } {
  const utcMidnight = Date.parse(`${localDate}T00:00:00Z`)
  return { start: utcMidnight - 14 * HOUR_MS, end: utcMidnight + 38 * HOUR_MS }
}

/**
 * The absolute hour an instant falls in, once shifted by an offset: not the local hour within a
 * day (`localHourOf`, 0-23), which resets at every midnight, but an index that keeps climbing
 * across a boundary. That is what lets a span crossing midnight, or two spans on different
 * calendar days, count as distinct hours instead of colliding on the same 0-23 label. mergeDay,
 * mergeSleepDay's merged night and deriveExerciseDay's merged workouts all count how many of
 * these hours a source's rows or sessions occupy, so it lives once here rather than as three
 * copies of the same shift-then-divide that could quietly stop agreeing with each other.
 */
export function absoluteHourOf(utcMs: number, offsetMinutes: number): number {
  return Math.floor((utcMs + offsetMinutes * 60_000) / HOUR_MS)
}

const DAY_MS = 86_400_000

/**
 * Steps a calendar date by whole days. An ISO local date carries no zone, so stepping it as a
 * UTC midnight is exact: no offset applies and a daylight saving change never moves a calendar
 * date. Two callers had grown their own copy of this, which is one copy too many for the module
 * that exists to be the only place a day boundary is computed.
 */
export function shiftLocalDate(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}
