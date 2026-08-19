import { describe, it, expect } from 'vitest'
import { calendarLayout, weekdayIndex, WEEKDAY_LABELS } from '../src/charts/calendar.js'
import { july } from '../src/fixtures/july.js'

describe('calendar layout', () => {
  // The bug this replaces used the row's index modulo 7, which put 2026-07-01
  // (a Wednesday) in the Monday row and shifted every label for the whole month.
  it('reads the weekday off the date rather than the row number', () => {
    expect(WEEKDAY_LABELS[weekdayIndex('2026-07-01')]).toBe('Wed')
    expect(WEEKDAY_LABELS[weekdayIndex('2026-07-31')]).toBe('Fri')
    expect(WEEKDAY_LABELS[weekdayIndex('2026-07-05')]).toBe('Sun')
  })

  it('gives July 2026 five week columns, not thirty-one', () => {
    const { weeks, cells } = calendarLayout(july.days.map((d) => d.date))
    expect(weeks).toBe(5)
    expect(cells).toHaveLength(31)
    expect(cells[0]).toEqual({ date: '2026-07-01', week: 0, weekday: 2 })
    expect(cells.at(-1)).toEqual({ date: '2026-07-31', week: 4, weekday: 4 })
  })

  it('puts every date in exactly one cell', () => {
    const { cells } = calendarLayout(july.days.map((d) => d.date))
    const positions = cells.map((c) => `${c.week}:${c.weekday}`)
    expect(new Set(positions).size).toBe(cells.length)
  })

  it('handles an empty month without inventing a column', () => {
    expect(calendarLayout([])).toEqual({ weeks: 0, cells: [] })
  })
})
