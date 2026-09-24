import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScoreRing } from '../src/pages/dashboard/ScoreRing.js'
import { UsualGauge, gaugeScale, gaugeFraction } from '../src/pages/dashboard/UsualGauge.js'
import { WeekBars } from '../src/pages/dashboard/WeekBars.js'

describe('ScoreRing', () => {
  it('is an image named by its label, with the score written in it', () => {
    const html = renderToStaticMarkup(<ScoreRing value={72} size={124} label="Recovery 72, around your usual" emptyText="Not scored" />)
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Recovery 72, around your usual"')
    expect(html).toContain('>72<')
  })
  it('draws an empty ring and the empty text when unscored', () => {
    const html = renderToStaticMarkup(<ScoreRing value={null} size={124} label="Not scored yet" emptyText="Not scored" />)
    expect(html).toContain('>Not scored<')
    expect(html).not.toContain('score-ring-fill')
  })
})

describe('UsualGauge', () => {
  it('scales around the band so the band sits in the middle fifth', () => {
    expect(gaugeScale({ low: 52, high: 58, center: 55 })).toEqual({ min: 47.5, max: 62.5 })
  })
  it('still centres a zero-width band instead of collapsing to a point', () => {
    const scale = gaugeScale({ low: 5, high: 5, center: 5 })
    expect(scale).toEqual({ min: 2.5, max: 7.5 })
    expect(gaugeFraction(5, scale)).toBe(0.5)
  })
  it('clamps a far reading to the arc\'s end rather than off it', () => {
    expect(gaugeFraction(200, { min: 0, max: 100 })).toBe(1)
    expect(gaugeFraction(-5, { min: 0, max: 100 })).toBe(0)
  })
  it('marks an out-of-range reading with the warning class, and a thin or missing band with no band at all', () => {
    const out = renderToStaticMarkup(<UsualGauge value={61} unit="bpm" baseline={{ low: 52, high: 58, center: 55 }} standing="above" size={100} label="x" />)
    expect(out).toContain('usual-gauge-marker is-out')
    const none = renderToStaticMarkup(<UsualGauge value={61} unit="bpm" baseline={null} standing={null} size={100} label="x" />)
    expect(none).not.toContain('usual-gauge-band')
  })
})

describe('WeekBars', () => {
  it('draws seven bars, today last and highlighted, a silent day as no bar', () => {
    const html = renderToStaticMarkup(<WeekBars values={[1, 2, null, 4, 5, 6, 3]} tone="steps" label="Steps, last 7 days" />)
    expect(html.match(/<rect/g)!.length).toBe(6)
    expect(html).toContain('week-bar is-today')
  })
})
