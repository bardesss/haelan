import { calendarLayout } from './calendar.js'
import type { DayRow } from '../fixtures/july.js'

/** One week of the heart rate range: `date` is its first day in the period, `to` its last. */
export interface HeartRateWeek extends DayRow { to: string }

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

/**
 * The heart rate range's points on 3 months and Year: one per Monday-to-Sunday week (calendarLayout's
 * weeks), clipped to the period, so the first and last week hold only the days the period does. A
 * week's minimum is its lowest daily minimum, its maximum its highest daily maximum, and its mean the
 * mean of its daily means; each column reads only the days that carry it. A week with no reading in
 * a column leaves that column null, a gap on the chart rather than a value drawn across from its
 * neighbours. A week reads "not worn" only when none of its days was worn.
 *
 * Aggregation, not judgement: the days are the ones the card already fetched, in date order, one
 * per date in the period.
 */
export function heartRateWeeks(days: readonly DayRow[]): HeartRateWeek[] {
  const { cells } = calendarLayout(days.map((day) => day.date))
  const groups: DayRow[][] = []
  cells.forEach((cell, index) => { (groups[cell.week] ??= []).push(days[index]!) })
  return groups.filter((group) => group !== undefined).map((group) => {
    const present = (pick: (day: DayRow) => number | null) =>
      group.map(pick).filter((value): value is number => value !== null)
    const mins = present((day) => day.hrMin)
    const maxes = present((day) => day.hrMax)
    return {
      date: group[0]!.date,
      to: group[group.length - 1]!.date,
      steps: null, sleepMinutes: null,
      hrMin: mins.length === 0 ? null : Math.min(...mins),
      hrMean: mean(present((day) => day.hrMean)),
      hrMax: maxes.length === 0 ? null : Math.max(...maxes),
      worn: group.some((day) => day.worn),
    }
  })
}
