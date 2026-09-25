import { describe, expect, it } from 'vitest'
import type { ComponentProps } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
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

const WEEK_DATES = ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']

function weekBars(props: Partial<ComponentProps<typeof WeekBars>> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider lng="en">
      <WeekBars values={[8900, 2, null, 4, 5, 9840, 4820]} dates={WEEK_DATES} tone="steps" label="Steps, last 7 days"
        line="Steps" language="en" format={(v) => v.toLocaleString('en')} current="2026-09-23" {...props} />
    </I18nProvider>,
  )
}

describe('WeekBars', () => {
  it('draws seven slots, today last and highlighted, a silent day as no bar', () => {
    const html = weekBars()
    expect(html.match(/class="week-bar(?: is-today)?"/g)!.length).toBe(6)
    expect(html.match(/class="week-bar-gap"/g)!.length).toBe(1)
    expect(html).toContain('week-bar is-today')
  })

  // Task 19b, then M9c: each bar carries its own day and value in words for a screen reader,
  // formatted the same way the row beside it prints its figure. No native <title> tooltip: the
  // styled one below is the only hover, and the name lives on the bar itself.
  it('names each bar with its day and value in words, and has no native tooltip', () => {
    const html = weekBars()
    expect(html).toContain('aria-label="Thursday, September 17: Steps 8,900"')
    expect(html).toContain('aria-label="Wednesday, September 23: Steps 4,820"')
    expect(html).not.toContain('<title')
  })

  it('makes every bar but the day shown a button named for opening its day', () => {
    const html = weekBars({ onPick: () => {} })
    expect(html).toContain('<button type="button" class="week-bar-slot" aria-label="Open Tuesday, September 22: Steps 9,840"')
    expect(html.match(/<button/g)!.length).toBe(5)
    expect(html).toContain('<span class="week-bar-slot" role="img" aria-label="Wednesday, September 23: Steps 4,820"')
  })
})
