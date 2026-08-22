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
