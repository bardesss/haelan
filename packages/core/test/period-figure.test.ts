import { describe, expect, it } from 'vitest'
import { blockMean, periodTotalUsual, periodUsual, periodFigureOf, countsOf, highOf, changeOf, PERIOD_MIN_PERIODS } from '../src/query/periodFigure.ts'
import { periodBounds, datesIn } from '../src/query/periodBounds.ts'
import type { Baseline } from '../src/query/baseline.ts'

const fill = (from: string, to: string, valueOf: (date: string, i: number) => number | null) => {
  const map = new Map<string, number>()
  datesIn({ from, to }).forEach((date, i) => { const v = valueOf(date, i); if (v !== null) map.set(date, v) })
  return map
}
const band = (center: number, spread: number, thin = false): Baseline => ({ center, spread, n: 60, thin })

describe('blockMean', () => {
  it('needs 70% of the days, counting only up to lastDay', () => {
    const values = fill('2026-09-01', '2026-09-10', (_, i) => (i < 7 ? 10 : null))
    expect(blockMean(values, { from: '2026-09-01', to: '2026-09-10' }, '2026-09-30')).toEqual({ mean: 10, days: 7 })
    const six = fill('2026-09-01', '2026-09-10', (_, i) => (i < 6 ? 10 : null))
    expect(blockMean(six, { from: '2026-09-01', to: '2026-09-10' }, '2026-09-30')).toEqual({ mean: null, days: 6 })
    // Only three dates exist up to lastDay, and all three carry a value.
    expect(blockMean(six, { from: '2026-09-01', to: '2026-09-10' }, '2026-09-03').mean).toBe(10)
  })
})

describe('periodUsual', () => {
  const bounds = periodBounds('month', '2026-09-15')
  it('is the mean and deviation of the earlier months, window named', () => {
    // Months alternate 400 / 440 over the twelve before September.
    const values = fill('2025-09-01', '2026-08-31', (date) => (Number(date.slice(5, 7)) % 2 === 0 ? 400 : 440))
    const usual = periodUsual(values, 'month', bounds, 1)!
    expect(usual.center).toBeCloseTo(420)
    expect(usual.periods).toBe(12)
    expect(usual.thin).toBe(false)
    expect(usual.window).toEqual({ unit: 'month', count: 12, from: '2025-09-01', to: '2026-08-31' })
  })
  it('is thin one below the minimum and not thin at it', () => {
    const at = fill('2026-01-01', '2026-08-31', () => 400) // 8 months
    const below = fill('2026-02-01', '2026-08-31', () => 400) // 7 months
    expect(PERIOD_MIN_PERIODS.month).toBe(8)
    expect(periodUsual(at, 'month', bounds, 1)!.thin).toBe(false)
    expect(periodUsual(below, 'month', bounds, 1)!.thin).toBe(true)
  })
  it('scales by 7 for a per-week figure', () => {
    const values = fill('2025-09-01', '2026-08-31', () => 30)
    expect(periodUsual(values, 'month', bounds, 7)!.center).toBeCloseTo(210)
  })
  it('is null with no earlier month counting', () => {
    expect(periodUsual(new Map(), 'month', bounds, 1)).toBeNull()
  })
})

describe('periodTotalUsual', () => {
  const bounds = periodBounds('month', '2026-09-15')
  it("is the earlier months' sums, each scaled to the period's length", () => {
    // 10 a day: a 31-day month sums 310 and a 30-day one 300, and both scale to September's 300.
    const values = fill('2025-09-01', '2026-08-31', () => 10)
    const usual = periodTotalUsual(values, 'month', bounds)!
    expect(usual.center).toBeCloseTo(300, 9)
    expect(usual.low).toBeCloseTo(300, 9)
    expect(usual).toMatchObject({ periods: 12, thin: false, window: { unit: 'month', count: 12, from: '2025-09-01', to: '2026-08-31' } })
  })
  it('sums a month the usual counts over the days it has, scaled by its length, not its days with a value', () => {
    // Every month full at 10 a day, but August 2026 with its last eight days missing (74% present).
    const values = fill('2025-09-01', '2026-08-31', (date) => (date >= '2026-08-24' ? null : 10))
    const usual = periodTotalUsual(values, 'month', bounds)!
    expect(usual.periods).toBe(12)
    expect(usual.center).toBeCloseTo((11 * 300 + 230 * 30 / 31) / 12, 9)
  })
  it('leaves out a month the usual leaves out, so it is thin when the usual is', () => {
    const values = fill('2026-02-01', '2026-08-31', () => 10) // 7 months
    values.set('2026-01-15', 10) // one day of January: not a month with 70% of its days
    expect(periodTotalUsual(values, 'month', bounds)).toMatchObject({ periods: 7, thin: true })
    expect(periodUsual(values, 'month', bounds, 1)).toMatchObject({ periods: 7, thin: true })
  })
  it('is null with no earlier month counting', () => {
    expect(periodTotalUsual(new Map(), 'month', bounds)).toBeNull()
  })
})

describe('periodFigureOf', () => {
  const base = { metric: 'steps', unit: 'count', precision: 0, direction: 'up' as const, additive: true }
  const history = fill('2025-09-01', '2026-08-31', (date) => (Number(date.slice(5, 7)) % 2 === 0 ? 8000 : 9000))
  const bands = new Map(datesIn({ from: '2026-09-01', to: '2026-09-30' }).map((d) => [d, band(8500, 1000)] as const))

  it('judges the average against the usual, counts days against their own bands', () => {
    const values = new Map(history)
    datesIn({ from: '2026-09-01', to: '2026-09-30' }).forEach((d, i) => values.set(d, i < 3 ? 12000 : 9500))
    const f = periodFigureOf({ ...base, range: 'month', anchor: '2026-09-15', lastDay: '2026-09-30', values, dailyBands: bands })
    expect(f.value).toBeCloseTo((3 * 12000 + 27 * 9500) / 30)
    expect(f.total).toBe(3 * 12000 + 27 * 9500)
    expect(f.standing).toBe('above')
    expect(f.judged).toBe('better')
    expect(f.reason).toBeNull()
    expect(f.counts).toEqual({ within: 27, above: 3, below: 0, unjudged: 0 })
    expect(f.daily).toHaveLength(30)
    expect(f.weekly).toBeNull()
  })
  it('does not judge a running period on fewer than three days', () => {
    const values = new Map(history); values.set('2026-09-01', 20000); values.set('2026-09-02', 20000)
    const f = periodFigureOf({ ...base, range: 'month', anchor: '2026-09-15', lastDay: '2026-09-02', values, dailyBands: bands })
    expect(f.days).toBe(2)
    expect(f.standing).toBeNull()
    expect(f.reason).toBe('too-few-days')
    expect(f.daily).toHaveLength(2)
  })
  it('does judge a finished period with fewer than three days', () => {
    const values = new Map(history); values.set('2026-09-01', 20000); values.set('2026-09-02', 20000)
    const f = periodFigureOf({ ...base, range: 'month', anchor: '2026-09-15', lastDay: '2026-10-05', values, dailyBands: bands })
    expect(f.standing).toBe('above')
  })
  it('names the reason for no data and for a thin usual', () => {
    expect(periodFigureOf({ ...base, range: 'month', anchor: '2026-09-15', lastDay: '2026-09-30', values: history, dailyBands: bands }).reason).toBe('no-data')
    const none = periodFigureOf({ ...base, range: 'month', anchor: '2026-09-15', lastDay: '2026-09-30', values: history, dailyBands: bands })
    expect(none.total).toBeNull()
    expect(none.standing).toBeNull()
    const values = fill('2026-09-01', '2026-09-30', () => 9000)
    expect(periodFigureOf({ ...base, range: 'month', anchor: '2026-09-15', lastDay: '2026-09-30', values, dailyBands: bands }).reason).toBe('thin-usual')
  })
  it('a thin but present usual is named thin-usual, not left without a reason', () => {
    // Seven earlier months: a usual exists, but one below the minimum of eight.
    const values = fill('2026-02-01', '2026-09-30', () => 9000)
    const f = periodFigureOf({ ...base, range: 'month', anchor: '2026-09-15', lastDay: '2026-09-30', values, dailyBands: bands })
    expect(f.usual!.thin).toBe(true)
    expect(f.standing).toBeNull()
    expect(f.reason).toBe('thin-usual')
  })
  it('a running period with no days is no-data, not too-few-days', () => {
    const f = periodFigureOf({ ...base, range: 'month', anchor: '2026-09-15', lastDay: '2026-09-02', values: history, dailyBands: bands })
    expect(f.days).toBe(0)
    expect(f.reason).toBe('no-data')
  })
  it('a non-additive figure has no total, and no usual for one', () => {
    const values = new Map(history); values.set('2026-09-01', 9000)
    const f = periodFigureOf({ ...base, additive: false, range: 'month', anchor: '2026-09-15', lastDay: '2026-10-01', values, dailyBands: bands })
    expect([f.total, f.usualTotal, f.totalStanding, f.totalJudged]).toEqual([null, null, null, null])
  })
  it("judges a finished period's total against the usual for its total", () => {
    const values = new Map(history)
    datesIn({ from: '2026-09-01', to: '2026-09-30' }).forEach((d) => values.set(d, 12000))
    const f = periodFigureOf({ ...base, range: 'month', anchor: '2026-09-15', lastDay: '2026-09-30', values, dailyBands: bands })
    expect(f.usualTotal).toMatchObject({ periods: 12, thin: false })
    expect(f.usualTotal!.high).toBeLessThan(f.total!)
    expect([f.totalStanding, f.totalJudged]).toEqual(['above', 'better'])
  })
  it("leaves a running period's total unjudged, however far past the usual it is", () => {
    const values = new Map(history)
    datesIn({ from: '2026-09-01', to: '2026-09-20' }).forEach((d) => values.set(d, 40000))
    const f = periodFigureOf({ ...base, range: 'month', anchor: '2026-09-15', lastDay: '2026-09-20', values, dailyBands: bands })
    expect(f.total).toBeGreaterThan(f.usualTotal!.high)
    expect([f.totalStanding, f.totalJudged]).toEqual([null, null])
    expect(f.standing).toBe('above')
  })
  it('per week multiplies value and usual by seven, but not the total', () => {
    const values = fill('2025-09-01', '2026-09-30', () => 30)
    const f = periodFigureOf({ ...base, metric: 'active_minutes', per: 'week', range: 'month', anchor: '2026-09-15', lastDay: '2026-09-30', values, dailyBands: bands })
    expect(f.value).toBeCloseTo(210)
    expect(f.usual!.center).toBeCloseTo(210)
    expect(f.total).toBe(30 * 30)
  })
  it('per week leaves each daily point unscaled, against the band of that day', () => {
    const values = fill('2025-09-01', '2026-09-30', () => 30)
    const dayBands = new Map(datesIn({ from: '2026-09-01', to: '2026-09-30' }).map((d) => [d, band(25, 4)] as const))
    const f = periodFigureOf({ ...base, metric: 'active_minutes', per: 'week', range: 'month', anchor: '2026-09-15', lastDay: '2026-09-30', values, dailyBands: dayBands })
    expect(f.daily[0]!.value).toBe(30)
    expect(f.daily[0]!.band).toMatchObject({ center: 25, low: 21, high: 29 })
    expect(f.daily[0]!.standing).toBe('above')
  })
  it('draws weekly points on 3months, each against its own twelve weeks', () => {
    const values = fill('2025-01-01', '2026-09-30', (d) => (d >= '2026-09-07' && d <= '2026-09-13' ? 20000 : 9000 + (Number(d.slice(8)) % 3) * 100))
    const f = periodFigureOf({ ...base, range: '3months', anchor: '2026-09-15', lastDay: '2026-09-30', values, dailyBands: new Map() })
    expect(f.weekly).not.toBeNull()
    expect(f.weekly![0]!.from).toBe('2026-07-01') // clipped to the period
    const spike = f.weekly!.find((w) => w.from === '2026-09-07')!
    expect(spike.value).toBe(20000)
    expect(spike.standing).toBe('above')
    expect(f.daily.every((d) => d.band === null && d.standing === null)).toBe(true)
  })
  it('judges a clipped first week against the twelve full Monday weeks before its Monday', () => {
    // 2026-07-01 is a Wednesday. A rising ramp makes a band drawn from Wednesday-start weeks differ
    // from one drawn from the twelve Monday weeks ending 2026-06-28.
    const ramp = (d: string) => 1000 + (Date.parse(`${d}T00:00:00Z`) - Date.parse('2025-01-01T00:00:00Z')) / 86_400_000
    const values = fill('2025-01-01', '2026-09-30', ramp)
    const f = periodFigureOf({ ...base, range: '3months', anchor: '2026-09-15', lastDay: '2026-09-30', values, dailyBands: new Map() })
    const first = f.weekly![0]!
    expect(first.from).toBe('2026-07-01')
    const monday = datesIn({ from: '2026-04-06', to: '2026-06-28' })
    expect(first.band!.center).toBeCloseTo(monday.reduce((s, d) => s + ramp(d), 0) / monday.length)
    expect(first.band!.thin).toBe(false)
  })
  it('per period scales value and usual to the whole period, a running one included, but not the total', () => {
    // One a fortnight: the 1st and the 15th of every month.
    const values = fill('2025-01-01', '2026-09-30', (d) => (d.endsWith('-01') || d.endsWith('-15') ? 1 : 0))
    const f = periodFigureOf({ ...base, metric: 'sleep_nap_count', per: 'period', range: 'month', anchor: '2026-09-15', lastDay: '2026-09-20', values, dailyBands: new Map() })
    expect(f.per).toBe('period')
    // Two in the twenty days so far is a pace of three over September's thirty.
    expect(f.value).toBeCloseTo(3)
    expect(f.total).toBe(2)
    // Two in each earlier month, each month's mean taken over September's thirty days.
    const thirty = periodUsual(values, 'month', periodBounds('month', '2026-09-15'), 30)!
    expect(f.usual!.center).toBeCloseTo(thirty.center)
    expect(f.daily[0]!.value).toBe(1)
  })
  it('does not judge a per-period figure while its period runs, and judges it once the period is over', () => {
    // One nap on the 1st of every month, and a second on the 15th of every other month: a usual with a width.
    const values = fill('2025-01-01', '2026-09-30', (d) => (d.endsWith('-01') || (d.endsWith('-15') && Number(d.slice(5, 7)) % 2 === 0) ? 1 : 0))
    const input = { ...base, metric: 'sleep_nap_count', per: 'period' as const, range: 'month' as const, anchor: '2026-09-15', values, dailyBands: new Map() }
    const running = periodFigureOf({ ...input, lastDay: '2026-09-20' })
    expect(running.usual!.thin).toBe(false)
    expect(running.value).not.toBeNull()
    expect(running).toMatchObject({ standing: null, judged: null, reason: null, total: 1 })
    const finished = periodFigureOf({ ...input, lastDay: '2026-09-30' })
    expect(finished.standing).not.toBeNull()
    // A per-day figure over the same running days is judged: only a period's worth waits for its end.
    expect(periodFigureOf({ ...input, per: 'day', lastDay: '2026-09-20' }).standing).not.toBeNull()
  })
  it("scales a per-period figure's weekly points by seven, a week's worth", () => {
    const values = fill('2025-01-01', '2026-09-30', () => 1)
    const f = periodFigureOf({ ...base, metric: 'sleep_nap_count', per: 'period', range: '3months', anchor: '2026-09-15', lastDay: '2026-09-30', values, dailyBands: new Map() })
    expect(f.value).toBeCloseTo(92)
    expect(f.weekly![1]!.value).toBeCloseTo(7)
    expect(f.weekly![1]!.band!.center).toBeCloseTo(7)
  })
  it('scales weekly values and bands by seven for a per-week figure', () => {
    const values = fill('2025-01-01', '2026-09-30', () => 30)
    const f = periodFigureOf({ ...base, metric: 'active_minutes', per: 'week', range: '3months', anchor: '2026-09-15', lastDay: '2026-09-30', values, dailyBands: new Map() })
    const w = f.weekly![1]!
    expect(w.value).toBeCloseTo(210)
    expect(w.band!.center).toBeCloseTo(210)
  })
})

describe('countsOf, highOf, changeOf', () => {
  const point = (from: string, value: number | null, standing: 'within' | 'above' | 'below' | null, judged: 'better' | 'worse' | null) =>
    ({ from, to: from, value, band: null, standing, judged, days: value === null ? 0 : 1 })
  it('counts only days with a value', () => {
    expect(countsOf([point('a', 1, 'within', null), point('b', null, null, null), point('c', 2, null, null), point('d', 3, 'below', 'worse')]))
      .toEqual({ within: 1, above: 0, below: 1, unjudged: 1 })
  })
  it('the high point is the largest, the earliest on a tie, good when better', () => {
    expect(highOf([point('2026-09-01', 5, 'within', null), point('2026-09-02', 9, 'above', 'better'), point('2026-09-03', 9, 'above', 'better')]))
      .toEqual({ localDate: '2026-09-02', value: 9, good: true })
    expect(highOf([point('2026-09-01', null, null, null)])).toBeNull()
  })
  it('the change is current minus the earlier span, null when either side is', () => {
    const values = fill('2026-08-01', '2026-08-31', () => 400)
    expect(changeOf(values, { from: '2026-08-01', to: '2026-08-31' }, 423, '2026-09-30', 1)).toEqual({ from: '2026-08-01', to: '2026-08-31', value: 400, delta: 23 })
    expect(changeOf(new Map(), { from: '2026-08-01', to: '2026-08-31' }, 423, '2026-09-30', 1).delta).toBeNull()
    expect(changeOf(values, { from: '2026-08-01', to: '2026-08-31' }, null, '2026-09-30', 1).delta).toBeNull()
  })
})
