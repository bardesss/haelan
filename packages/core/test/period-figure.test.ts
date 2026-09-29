import { describe, expect, it } from 'vitest'
import { blockMean, periodUsual, periodFigureOf, countsOf, highOf, changeOf, PERIOD_MIN_PERIODS } from '../src/query/periodFigure.ts'
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
    const values = fill('2026-09-01', '2026-09-30', () => 9000)
    expect(periodFigureOf({ ...base, range: 'month', anchor: '2026-09-15', lastDay: '2026-09-30', values, dailyBands: bands }).reason).toBe('thin-usual')
  })
  it('a non-additive figure has no total', () => {
    const values = new Map(history); values.set('2026-09-01', 9000)
    expect(periodFigureOf({ ...base, additive: false, range: 'month', anchor: '2026-09-15', lastDay: '2026-10-01', values, dailyBands: bands }).total).toBeNull()
  })
  it('per week multiplies value, usual and points by seven, but not the total', () => {
    const values = fill('2025-09-01', '2026-09-30', () => 30)
    const f = periodFigureOf({ ...base, metric: 'active_minutes', per: 'week', range: 'month', anchor: '2026-09-15', lastDay: '2026-09-30', values, dailyBands: bands })
    expect(f.value).toBeCloseTo(210)
    expect(f.usual!.center).toBeCloseTo(210)
    expect(f.daily[0]!.value).toBeCloseTo(210)
    expect(f.daily[0]!.band!.center).toBeCloseTo(8500 * 7)
    expect(f.total).toBe(30 * 30)
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
