import { describe, it, expect } from 'vitest'
import { longestRun, MIN_RUN_DAYS } from '../src/api/runs.ts'

/** `days` consecutive dates from `from`. */
const run = (from: string, days: number): string[] => {
  const start = Date.parse(`${from}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10))
}

describe('longestRun', () => {
  it('answers the longest unbroken stretch of dates', () => {
    expect(longestRun(run('2026-01-01', 10), MIN_RUN_DAYS))
      .toEqual({ from: '2026-01-01', to: '2026-01-10', days: 10 })
  })

  it('treats a missing day as breaking the run', () => {
    // Eight days, one day missing, then nine. The nine wins and nothing answers seventeen.
    const broken = [...run('2026-01-01', 8), ...run('2026-01-10', 9)]
    expect(longestRun(broken, MIN_RUN_DAYS))
      .toEqual({ from: '2026-01-10', to: '2026-01-18', days: 9 })
  })

  it('answers null below the floor rather than a run nobody would call a habit', () => {
    // The measurement behind the floor: the longest run at or above 10,000 steps in this
    // household's whole archive is two days. "Longest streak: 2 days" reads as a criticism.
    expect(longestRun(run('2026-01-01', MIN_RUN_DAYS - 1), MIN_RUN_DAYS)).toBeNull()
  })

  it('answers a run exactly at the floor', () => {
    expect(longestRun(run('2026-01-01', MIN_RUN_DAYS), MIN_RUN_DAYS)?.days).toBe(MIN_RUN_DAYS)
  })

  it('takes the dates unsorted and repeated', () => {
    // The reader hands over dates gathered per metric per day, so the same date arrives more
    // than once and in no guaranteed order. Counted twice, a run would measure longer than the
    // calendar allows.
    const messy = [...run('2026-01-01', 10)].reverse().flatMap((date) => [date, date])
    expect(longestRun(messy, MIN_RUN_DAYS))
      .toEqual({ from: '2026-01-01', to: '2026-01-10', days: 10 })
  })

  it('answers null for no dates at all', () => {
    expect(longestRun([], MIN_RUN_DAYS)).toBeNull()
  })

  it('counts across a daylight saving boundary as ordinary days', () => {
    // Europe/Amsterdam springs forward on 2026-03-29. Date arithmetic done in local time makes
    // that day 23 hours and the two dates either side look non-consecutive; parsed as UTC
    // midnights they are a day apart, which is what a civil date means here.
    const across = run('2026-03-25', 10)
    expect(longestRun(across, MIN_RUN_DAYS)?.days).toBe(10)
  })
})
