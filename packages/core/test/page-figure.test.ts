import { describe, it, expect } from 'vitest'
import { judge, usualOf, pageFigureOf, figureFromValues } from '../src/query/pageFigure.ts'
import type { GlanceFigure } from '../src/query/glance.ts'

describe('judge', () => {
  it('reads above as better only for a metric where up is good', () => {
    expect(judge('above', 'up')).toBe('better')
    expect(judge('below', 'up')).toBe('worse')
    expect(judge('above', 'down')).toBe('worse')
    expect(judge('below', 'down')).toBe('better')
  })
  it('says nothing inside the band, for a neutral metric, or with no standing', () => {
    expect(judge('within', 'up')).toBeNull()
    expect(judge('above', 'neutral')).toBeNull()
    expect(judge(null, 'up')).toBeNull()
  })
})

describe('usualOf', () => {
  it('is the mean plus and minus the sample deviation', () => {
    expect(usualOf([10, 20, 30], 3)).toEqual({ center: 20, low: 10, high: 30, thin: false })
  })
  it('is thin below the minimum count, and absent with no values', () => {
    expect(usualOf([10, 20], 3)?.thin).toBe(true)
    expect(usualOf([], 3)).toBeNull()
  })
  it('has no spread from a single value', () => {
    expect(usualOf([42], 1)).toEqual({ center: 42, low: 42, high: 42, thin: false })
  })
})

const GLANCE: GlanceFigure = {
  metric: 'sleep_deep_minutes', value: 64, unit: 'minutes',
  baseline: { center: 85, low: 70, high: 100, thin: false },
  asOfDate: '2026-09-06', asOfMs: 1, partial: false, staleSources: [],
  strip: [{ localDate: '2026-09-06', value: 64, band: { center: 85, low: 70, high: 100, thin: false }, standing: 'below' }],
  standing: 'below',
}

describe('pageFigureOf', () => {
  it('carries the glance figure over and judges it from the catalogue direction', () => {
    expect(pageFigureOf(GLANCE, true)).toEqual({
      metric: 'sleep_deep_minutes', value: 64, unit: 'minutes', precision: 0, direction: 'up',
      baseline: GLANCE.baseline, standing: 'below', judged: 'worse', strip: GLANCE.strip,
    })
  })
  it('drops the strip when the page draws a bar instead', () => {
    expect(pageFigureOf(GLANCE, false).strip).toBeNull()
  })
})

describe('figureFromValues', () => {
  it('judges a figure the daily table does not hold against its own history', () => {
    const figure = figureFromValues({ metric: 'sleep_latency_minutes', unit: 'minutes', precision: 0, direction: 'down',
      value: 40, history: [10, 12, 14, 16, 18], minN: 5 })
    expect(figure.baseline).toEqual({ center: 14, low: 14 - Math.sqrt(10), high: 14 + Math.sqrt(10), thin: false })
    expect(figure.standing).toBe('above')
    expect(figure.judged).toBe('worse')
  })
  it('claims no standing on a thin history', () => {
    const figure = figureFromValues({ metric: 'x', unit: 'minutes', precision: 0, direction: 'down', value: 40, history: [10], minN: 5 })
    expect(figure.standing).toBeNull()
    expect(figure.judged).toBeNull()
  })
})
