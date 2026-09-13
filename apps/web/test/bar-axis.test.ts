import { describe, it, expect } from 'vitest'
import { barLabelInterval, barDateLabels } from '../src/charts/barAxis.js'

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
