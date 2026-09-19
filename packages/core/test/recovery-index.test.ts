import { describe, expect, it } from 'vitest'
import { recoveryWindowStart, zSeries, SLEEP_WEEK_DAYS, sleepWeekSeries } from '../src/api/recoveryIndex.ts'
import type { DayValue } from '../src/api/recoveryIndex.ts'

/**
 * 60 days alternating one unit either side of `flat`, then one day that deviates sharply.
 *
 * The alternation matters: `zScoreOf` returns null for a literally constant baseline (spread
 * exactly zero is not a number of standard deviations), so a truly flat history could never
 * produce the finite "large z" this helper exists to test. Alternating keeps the baseline tight
 * -- nothing like the deviating day below -- while giving it a real, small, computable spread.
 */
function flatThenSpike(endDate: string, flat: number, spike: number): DayValue[] {
  const days: DayValue[] = []
  for (let back = 60; back >= 1; back -= 1) {
    days.push({ localDate: shift(endDate, -back), value: flat + (back % 2 === 0 ? 1 : -1) })
  }
  days.push({ localDate: endDate, value: spike })
  return days
}

function shift(date: string, by: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + by * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

describe('recoveryWindowStart', () => {
  it('reaches back far enough for a 60 day baseline whose oldest day needs its own sleep week', () => {
    // 60 baseline days ending the day before, and the oldest of those needs 6 days before it.
    expect(recoveryWindowStart('2026-09-14')).toBe('2026-07-10')
    expect(SLEEP_WEEK_DAYS).toBe(7)
  })
})

describe('zSeries', () => {
  it('withholds a day whose history never varied, because zero spread measures nothing', () => {
    const days: DayValue[] = []
    for (let back = 60; back >= 0; back -= 1) days.push({ localDate: shift('2026-09-14', -back), value: 50 })
    const z = zSeries(days, { from: '2026-09-14', to: '2026-09-14' }, 'up')
    // A flat history has zero spread, so there is no distance measurable in units of it.
    expect(z.get('2026-09-14')).toBeNull()
  })

  it('signs a deviation by direction, so positive always means better recovered', () => {
    const days = flatThenSpike('2026-09-14', 50, 60)
    // One differing day in an otherwise flat window gives a large but finite z.
    const up = zSeries(days, { from: '2026-09-14', to: '2026-09-14' }, 'up')
    const down = zSeries(days, { from: '2026-09-14', to: '2026-09-14' }, 'down')
    expect(up.get('2026-09-14')).toBeGreaterThan(0)
    expect(down.get('2026-09-14')).toBe(-(up.get('2026-09-14') as number))
  })

  it('withholds a day whose baseline is thin', () => {
    const days: DayValue[] = []
    for (let back = 10; back >= 0; back -= 1) days.push({ localDate: shift('2026-09-14', -back), value: 40 + back })
    const z = zSeries(days, { from: '2026-09-14', to: '2026-09-14' }, 'up')
    expect(z.get('2026-09-14')).toBeNull()
  })

  it('never lets a day contribute to the baseline it is judged against', () => {
    const days = flatThenSpike('2026-09-14', 50, 500)
    const z = zSeries(days, { from: '2026-09-14', to: '2026-09-14' }, 'up')
    // If day D leaked into its own window the spread would swallow the spike and z would be small.
    expect(z.get('2026-09-14')).toBeGreaterThan(10)
  })
})

describe('sleepWeekSeries', () => {
  const week = (end: string, values: number[]): DayValue[] =>
    values.map((value, index) => ({ localDate: shift(end, index - (values.length - 1)), value }))

  it('averages asleep minutes over the seven days ending on each date', () => {
    const asleep = week('2026-09-14', [400, 410, 420, 430, 440, 450, 460])
    const { duration } = sleepWeekSeries(asleep, [], { from: '2026-09-14', to: '2026-09-14' })
    expect(duration).toEqual([{ localDate: '2026-09-14', value: 430 }])
  })

  it('measures consistency as the spread of bedtimes, so a steady week is a small number', () => {
    const steady = week('2026-09-14', [1380, 1380, 1380, 1380, 1380, 1380, 1380])
    const erratic = week('2026-09-14', [1200, 1440, 1260, 1380, 1320, 1400, 1250])
    const range = { from: '2026-09-14', to: '2026-09-14' }
    const a = sleepWeekSeries([], steady, range).consistency[0]
    const b = sleepWeekSeries([], erratic, range).consistency[0]
    expect(a?.value).toBe(0)
    expect(b?.value).toBeGreaterThan(0)
  })

  it('omits a date whose week holds too few observed nights, rather than averaging two of seven', () => {
    const sparse: DayValue[] = [
      { localDate: '2026-09-13', value: 400 },
      { localDate: '2026-09-14', value: 420 },
    ]
    const { duration } = sleepWeekSeries(sparse, [], { from: '2026-09-14', to: '2026-09-14' })
    expect(duration).toEqual([])
  })
})
