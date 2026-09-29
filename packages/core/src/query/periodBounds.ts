import { shiftLocalDate } from '../derive/localDay.ts'

/**
 * The period the overview pages read: which days a range covers for an anchor, how to step it,
 * and the earlier same-length blocks it is judged against. `periodBounds` and `stepPeriod` are the
 * server's copy of `datesFor` and `stepAnchor` in apps/web/src/controls/range.ts; the parity test
 * in apps/web/test/period-bounds-parity.test.ts keeps the two in step, so the page never prints a
 * verdict about days it is not showing. All arithmetic is on YYYY-MM-DD strings, in UTC.
 */
export type PeriodRange = 'week' | 'month' | '3months' | 'year'
export const PERIOD_RANGES: readonly PeriodRange[] = ['week', 'month', '3months', 'year']

export interface DateSpan { from: string, to: string }

function partsOf(date: string): { year: number, month: number, day: number } {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return { year, month, day }
}

function toDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Shifts by whole months, clamping the day onto the target month's length. */
function addMonths(date: string, months: number): string {
  const { year, month, day } = partsOf(date)
  const target = new Date(Date.UTC(year, month - 1 + months, 1))
  const ty = target.getUTCFullYear()
  const tm = target.getUTCMonth() + 1
  return toDate(ty, tm, Math.min(day, daysInMonth(ty, tm)))
}

function monthSpan(firstOfMonth: string, months: number): DateSpan {
  const end = addMonths(firstOfMonth, months - 1)
  const { year, month } = partsOf(end)
  return { from: firstOfMonth, to: toDate(year, month, daysInMonth(year, month)) }
}

function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return shiftLocalDate(date, -(weekday === 0 ? 6 : weekday - 1))
}

export function periodBounds(range: PeriodRange, anchor: string): DateSpan {
  const { year, month } = partsOf(anchor)
  switch (range) {
    case 'week': {
      const from = mondayOf(anchor)
      return { from, to: shiftLocalDate(from, 6) }
    }
    case 'month':
      return monthSpan(toDate(year, month, 1), 1)
    case '3months':
      return monthSpan(addMonths(toDate(year, month, 1), -2), 3)
    case 'year':
      return { from: toDate(year, 1, 1), to: toDate(year, 12, 31) }
  }
}

export function stepPeriod(range: PeriodRange, anchor: string, direction: -1 | 1): string {
  switch (range) {
    case 'week': return shiftLocalDate(anchor, 7 * direction)
    case 'month': return addMonths(anchor, direction)
    case '3months': return addMonths(anchor, 3 * direction)
    case 'year': return addMonths(anchor, 12 * direction)
  }
}

/** The earlier same-length blocks a period is judged against, oldest first. */
export function earlierBlocks(
  range: PeriodRange, bounds: DateSpan,
): { unit: 'week' | 'month' | 'quarter' | 'year', blocks: DateSpan[] } {
  const { from } = bounds
  switch (range) {
    case 'week': {
      const blocks = Array.from({ length: 12 }, (_, i) => {
        const start = shiftLocalDate(from, -7 * (12 - i))
        return { from: start, to: shiftLocalDate(start, 6) }
      })
      return { unit: 'week', blocks }
    }
    case 'month':
      return { unit: 'month', blocks: Array.from({ length: 12 }, (_, i) => monthSpan(addMonths(from, i - 12), 1)) }
    case '3months':
      return { unit: 'quarter', blocks: Array.from({ length: 4 }, (_, i) => monthSpan(addMonths(from, 3 * (i - 4)), 3)) }
    case 'year': {
      // One year has no spread of its own, so it is judged against the previous year's quarters.
      const { year } = partsOf(from)
      return { unit: 'year', blocks: Array.from({ length: 4 }, (_, i) => monthSpan(toDate(year - 1, 1 + 3 * i, 1), 3)) }
    }
  }
}

/** Monday-start weeks covering `span`, each clipped to it. */
export function weeksIn(span: DateSpan): DateSpan[] {
  const weeks: DateSpan[] = []
  for (let monday = mondayOf(span.from); monday <= span.to; monday = shiftLocalDate(monday, 7)) {
    const sunday = shiftLocalDate(monday, 6)
    weeks.push({ from: monday < span.from ? span.from : monday, to: sunday > span.to ? span.to : sunday })
  }
  return weeks
}

/** The earlier of two YYYY-MM-DD dates, which compare as strings. */
export const minDate = (a: string, b: string): string => (a < b ? a : b)

/** The same calendar date a year earlier; a leap day falls to 28 February. */
export function yearEarlierDate(date: string): string {
  const { year, month, day } = partsOf(date)
  return toDate(year - 1, month, Math.min(day, daysInMonth(year - 1, month)))
}

export function daysIn(span: DateSpan): number {
  return Math.round((Date.parse(`${span.to}T00:00:00Z`) - Date.parse(`${span.from}T00:00:00Z`)) / 86_400_000) + 1
}

export function datesIn(span: DateSpan): string[] {
  return Array.from({ length: daysIn(span) }, (_, i) => shiftLocalDate(span.from, i))
}
