import { ALL_SOURCES } from './source.js'

export const RANGE_KEYS = ['day', 'week', 'month', '3months', 'year'] as const
export type RangeKey = (typeof RANGE_KEYS)[number]

export interface PageControls {
  tab: RangeKey
  anchor: string
  source: string
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Every function here works on YYYY-MM-DD strings and does its arithmetic in UTC. Constructing
 * a local Date from a date string is the bug this avoids: new Date('2026-08-15') is parsed as
 * UTC midnight, so in any negative offset it reads back as the 14th. Date.UTC keeps the
 * arithmetic on the calendar rather than on an instant.
 */
function partsOf(date: string): { year: number, month: number, day: number } {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return { year, month, day }
}

function toDate(year: number, month: number, day: number): string {
  const utc = new Date(Date.UTC(year, month - 1, day))
  return utc.toISOString().slice(0, 10)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function isRealDate(date: string): boolean {
  if (!DATE_PATTERN.test(date)) return false
  const { year, month, day } = partsOf(date)
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

/** Shifts by whole days. Safe across month and year boundaries because it goes through epoch ms.
 *  Exported for the workout page's comparison window, its second caller: the ninety trailing days
 *  before a workout's own local date, computed the same way stepAnchor already shifts an anchor. */
export function addDays(date: string, days: number): string {
  const { year, month, day } = partsOf(date)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

/** Shifts by whole months, clamping the day onto the target month's length. */
function addMonths(date: string, months: number): string {
  const { year, month, day } = partsOf(date)
  const target = new Date(Date.UTC(year, month - 1 + months, 1))
  const targetYear = target.getUTCFullYear()
  const targetMonth = target.getUTCMonth() + 1
  return toDate(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)))
}

export function datesFor(tab: RangeKey, anchor: string): { from: string, to: string } {
  const { year, month } = partsOf(anchor)
  switch (tab) {
    case 'day':
      return { from: anchor, to: anchor }
    case 'week': {
      // getUTCDay is 0 for Sunday, so a Sunday is six days after its Monday rather than the
      // start of the next week.
      const weekday = new Date(`${anchor}T00:00:00Z`).getUTCDay()
      const back = weekday === 0 ? 6 : weekday - 1
      const from = addDays(anchor, -back)
      return { from, to: addDays(from, 6) }
    }
    case 'month':
      return { from: toDate(year, month, 1), to: toDate(year, month, daysInMonth(year, month)) }
    case '3months': {
      const start = addMonths(toDate(year, month, 1), -2)
      return { from: start, to: toDate(year, month, daysInMonth(year, month)) }
    }
    case 'year':
      return { from: toDate(year, 1, 1), to: toDate(year, 12, 31) }
  }
}

export interface HistoryBounds {
  historyStartMs: number | null
  googleConnected: boolean
}

/**
 * The person's history start as a local date, in their own zone. en-CA formats as
 * YYYY-MM-DD, the one shape every local date in this system already has, the same
 * way usePageControls computes today.
 */
export function historyStartLocalDate(historyStartMs: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(historyStartMs))
}

/**
 * Where a card range honestly starts for a phone-only history (T5.3 passo 3).
 *
 * A phone-only person has no rows before their first sync, so a tab opening earlier
 * asks for a window that can only come back empty: the card then reads "1 of 30 days"
 * and the one reporting day looks like 29 days of inactivity. Starting the range on
 * the history start makes the denominator what it is and the chart what it shows.
 * A person who also walks the Google path keeps the deep archive untouched, and a
 * range ending before the history starts is left alone so from never passes to.
 */
export function clampFromToHistory(
  from: string, to: string, history: HistoryBounds | undefined, timezone: string,
): string {
  // A history the hook has not resolved yet, or a wire answer with no number in it,
  // leaves the range alone: the clamp only ever narrows on a measured start.
  if (history === undefined || typeof history.historyStartMs !== 'number' || history.googleConnected) return from
  if (timezone === '') return from
  const start = historyStartLocalDate(history.historyStartMs, timezone)
  if (start <= from || start > to) return from
  return start
}

export function stepAnchor(tab: RangeKey, anchor: string, direction: -1 | 1): string {
  switch (tab) {
    case 'day': return addDays(anchor, direction)
    case 'week': return addDays(anchor, 7 * direction)
    case 'month': return addMonths(anchor, direction)
    case '3months': return addMonths(anchor, 3 * direction)
    case 'year': return addMonths(anchor, 12 * direction)
  }
}

export function parseControls(search: string, today: string): PageControls {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const tab = params.get('range')
  const anchor = params.get('on')
  const source = params.get('source')
  return {
    tab: (RANGE_KEYS as readonly string[]).includes(tab ?? '') ? tab as RangeKey : 'month',
    anchor: anchor !== null && isRealDate(anchor) ? anchor : today,
    // An empty source is a parameter that was written and left blank, not a choice. Nothing
    // narrower is possible here: which sources exist is a fact about this person's data, not
    // about the URL, so the enumerated check happens where that list is known (controls/source.ts).
    source: source === null || source === '' ? ALL_SOURCES : source,
  }
}
