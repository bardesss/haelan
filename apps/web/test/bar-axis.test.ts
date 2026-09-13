import { describe, it, expect } from 'vitest'
import { barLabelInterval } from '../src/charts/barAxis.js'

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
