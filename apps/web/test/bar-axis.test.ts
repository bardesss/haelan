import { describe, it, expect } from 'vitest'
import { barLabelInterval, barDateLabels, periodAxisLabels, stepAxisMax } from '../src/charts/barAxis.js'

describe('the bar chart x label interval', () => {
  // echarts' `axisLabel.interval` is the count of labels to SKIP between drawn ones, so 0 draws
  // every label and 4 draws every fifth. The target is roughly six labels at any range: enough to
  // place a bar in the month, few enough not to collide at span 6.
  it('draws every label when there are few enough to fit', () => {
    expect(barLabelInterval(7)).toBe(0)
  })

  it('thins a month to about six labels', () => {
    expect(barLabelInterval(30)).toBe(4)
  })

  it('thins three months and a year to about six as well', () => {
    expect(barLabelInterval(90)).toBe(14)
    expect(barLabelInterval(365)).toBe(59)
  })

  // A chart can legitimately be handed an empty range while its query is still pending, and an
  // interval derived from zero must not come out negative: echarts reads a negative interval as
  // "draw nothing", which would silently lose the axis on exactly the ranges this chart exists for.
  it('never returns a negative interval, however few points there are', () => {
    expect(barLabelInterval(0)).toBe(0)
    expect(barLabelInterval(1)).toBe(0)
  })
})

describe('the bar chart x axis date label', () => {
  // A week, entirely inside one calendar month: day-of-month alone, since the card's own period
  // line already says which month it is.
  it('shows day-of-month alone when every date falls in one calendar month', () => {
    expect(barDateLabels(['2026-08-14', '2026-08-15', '2026-08-20'])).toEqual(['14', '15', '20'])
  })

  // The finding's own broken cases: a quarter and a year of day-of-month alone repeat the same
  // handful of numbers with no month to tell them apart.
  it('switches to MM-DD once the dates cross a calendar month boundary', () => {
    expect(barDateLabels(['2026-06-14', '2026-07-14', '2026-08-14']))
      .toEqual(['06-14', '07-14', '08-14'])
  })

  it('switches to MM-DD across a full year, not seven near-identical day numbers', () => {
    expect(barDateLabels(['2026-01-09', '2026-06-15', '2026-12-31']))
      .toEqual(['01-09', '06-15', '12-31'])
  })

  // The property the fix asks for: the decision reads the dates' own months, not the count of
  // them. A range with more points than the broken 90/365 day cases above but that never leaves
  // one calendar month still gets day-of-month, which a length-based threshold could not tell
  // apart from a range that had actually crossed into a second month.
  it('stays on day-of-month for a whole month of points, never a count threshold', () => {
    const dates = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`)
    expect(barDateLabels(dates)).toEqual(dates.map((d) => d.slice(8)))
  })

  it('is empty for an empty range', () => {
    expect(barDateLabels([])).toEqual([])
  })
})

// Every date from `from` to `to`, inclusive.
const datesIn = (from: string, to: string): string[] => {
  const out: string[] = []
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) out.push(new Date(at).toISOString().slice(0, 10))
  return out
}

describe("an overview chart's x labels", () => {
  it("names a week's weekdays, every one", () => {
    const week = datesIn('2026-09-14', '2026-09-20')
    expect(periodAxisLabels(week, 'week', 'nl')).toEqual({ data: ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'], shown: Array(7).fill(true) })
    expect(periodAxisLabels(week, 'week', 'en').data).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  })

  it("numbers a month's days and prints every seventh from the first", () => {
    const axis = periodAxisLabels(datesIn('2026-08-01', '2026-08-31'), 'month', 'nl')
    expect(axis.data.slice(0, 3)).toEqual(['1', '2', '3'])
    expect(axis.data.filter((_, i) => axis.shown[i])).toEqual(['1', '8', '15', '22', '29'])
  })

  it('names each month under the first week that starts in it, on 3 months and a year', () => {
    // A quarter's weeks, the first clipped to the period's first day.
    const weeks = ['2026-07-01', '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10', '2026-08-31', '2026-09-07']
    const axis = periodAxisLabels(weeks, '3months', 'nl')
    expect(axis.data.filter((_, i) => axis.shown[i])).toEqual(['jul', 'aug', 'sep'])
    expect(axis.shown.slice(0, 2)).toEqual([true, false])
    expect(periodAxisLabels(['2025-01-01', '2025-03-03'], 'year', 'en').data).toEqual(['Jan', 'Mar'])
  })
})

describe("a stepped value axis's top", () => {
  it('ends on the data a quarter step or less past a step, and on the next step otherwise', () => {
    expect(stepAxisMax(485, 240)).toBe(485)
    expect(stepAxisMax(540, 240)).toBe(540)
    expect(stepAxisMax(541, 240)).toBe(720)
    expect(stepAxisMax(470, 240)).toBe(480)
    expect(stepAxisMax(100, 240)).toBe(240)
    expect(stepAxisMax(0, 240)).toBe(240)
  })
})
