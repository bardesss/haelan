// The heart rate range's weeks on 3 months and Year: Monday to Sunday, clipped to the period, each
// the week's lowest daily minimum, the mean of its daily means and its highest daily maximum. A
// week with nothing in it is a gap, never a value carried over from its neighbours.
import { describe, it, expect } from 'vitest'
import { heartRateWeeks } from '../src/charts/heartRateWeeks.js'
import type { DayRow } from '../src/fixtures/july.js'

const day = (date: string, hrMin: number | null, hrMean: number | null, hrMax: number | null, worn = true): DayRow =>
  ({ date, steps: null, sleepMinutes: null, hrMin, hrMean, hrMax, worn })

const silent = (date: string): DayRow => day(date, null, null, null)

describe('heartRateWeeks', () => {
  it('takes each week\'s lowest minimum, the mean of its means and its highest maximum', () => {
    // Monday 2026-08-03 to Sunday 2026-08-09, one silent day among them.
    const weeks = heartRateWeeks([
      day('2026-08-03', 50, 60, 120),
      day('2026-08-04', 48, 64, 150),
      silent('2026-08-05'),
      day('2026-08-06', 55, 62, 130),
      day('2026-08-07', 52, 66, 140),
      day('2026-08-08', 47, 70, 160),
      day('2026-08-09', 53, 68, 125),
    ])
    expect(weeks).toEqual([{
      date: '2026-08-03', to: '2026-08-09', steps: null, sleepMinutes: null,
      hrMin: 47, hrMean: 65, hrMax: 160, worn: true,
    }])
  })

  it('reads each column on its own, so a day with a mean but no minimum still counts toward the mean', () => {
    const [week] = heartRateWeeks([day('2026-08-03', null, 60, null), day('2026-08-04', 50, 70, 140)])
    expect(week).toMatchObject({ hrMin: 50, hrMean: 65, hrMax: 140 })
  })

  it('leaves a week with no readings as a gap, not a value from its neighbours', () => {
    const dates = Array.from({ length: 21 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 3 + i))
      return d.toISOString().slice(0, 10)
    })
    const weeks = heartRateWeeks(dates.map((date, i) => (i >= 7 && i < 14 ? silent(date) : day(date, 50, 60, 120))))
    expect(weeks.map((week) => week.date)).toEqual(['2026-08-03', '2026-08-10', '2026-08-17'])
    expect(weeks[1]).toMatchObject({ hrMin: null, hrMean: null, hrMax: null, worn: true })
    expect(weeks[0]!.hrMean).toBe(60)
    expect(weeks[2]!.hrMean).toBe(60)
  })

  it('says a week was not worn only when none of its days was', () => {
    const notWorn = (date: string) => day(date, null, null, null, false)
    expect(heartRateWeeks([notWorn('2026-08-03'), notWorn('2026-08-04')])[0]!.worn).toBe(false)
    expect(heartRateWeeks([notWorn('2026-08-03'), day('2026-08-04', 50, 60, 120)])[0]!.worn).toBe(true)
  })

  it('clips the first and the last week to the period', () => {
    // A year that starts on a Wednesday and ends on a Wednesday: its first week is Wed - Sun, its
    // last Mon - Wed, and both are named by the days they really hold.
    const dates: string[] = []
    for (let d = new Date(Date.UTC(2025, 0, 1)); d.getUTCFullYear() === 2025; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10))
    }
    const weeks = heartRateWeeks(dates.map((date) => day(date, 50, 60, 120)))
    expect(weeks).toHaveLength(53)
    expect(weeks[0]).toMatchObject({ date: '2025-01-01', to: '2025-01-05' })
    expect(weeks[1]).toMatchObject({ date: '2025-01-06', to: '2025-01-12' })
    expect(weeks[52]).toMatchObject({ date: '2025-12-29', to: '2025-12-31' })
  })

  it('draws nothing for no days', () => {
    expect(heartRateWeeks([])).toEqual([])
  })
})
