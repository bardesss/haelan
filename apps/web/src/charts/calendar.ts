// Monday first: the reference pages are British, and Sunday-first splits the weekend across two columns.
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export type CalendarCell = { date: string; week: number; weekday: number }

function epochDay(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(ms)) throw new Error(`not a date: ${date}`)
  return Math.floor(ms / 86_400_000)
}

// Weekday comes from the calendar, not array position: an off-by-one here is invisible without checking a real date.
export function weekdayIndex(date: string): number {
  const sundayFirst = new Date(`${date}T00:00:00Z`).getUTCDay()
  return (sundayFirst + 6) % 7
}

export function calendarLayout(dates: string[]): { weeks: number; cells: CalendarCell[] } {
  const first = dates[0]
  if (first === undefined) return { weeks: 0, cells: [] }
  const weekStart = epochDay(first) - weekdayIndex(first)
  const cells = dates.map((date) => ({
    date,
    week: Math.floor((epochDay(date) - weekStart) / 7),
    weekday: weekdayIndex(date),
  }))
  return { weeks: Math.max(...cells.map((c) => c.week)) + 1, cells }
}
