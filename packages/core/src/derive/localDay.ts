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
