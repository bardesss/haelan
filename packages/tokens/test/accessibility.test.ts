import { describe, it, expect } from 'vitest'
import { resolveChart, STAGE_KEYS } from '../src/chart.js'
import { resolveSemantic } from '../src/semantic.js'
import { deltaE } from '../src/color/convert.js'
import { simulate, type CvdKind } from '../src/color/cvd.js'
import { contrast } from '../src/color/contrast.js'
import { THEMES } from '../src/semantic.js'

const CVD: CvdKind[] = ['deuteranopia', 'protanopia', 'tritanopia']
const MIN_NORMAL = 25
const MIN_SIMULATED = 18

function pairs(values: string[]): [string, string][] {
  return values.flatMap((a, i) => values.slice(i + 1).map((b) => [a, b] as [string, string]))
}

describe.each(THEMES)('%s palette accessibility', (theme) => {
  const chart = resolveChart(theme)
  const stages = STAGE_KEYS.map((k) => chart[k]!)
  const s = resolveSemantic(theme)

  it('separates the sleep stages in normal vision', () => {
    for (const [a, b] of pairs(stages)) {
      expect(deltaE(a, b), `${a} vs ${b}`).toBeGreaterThanOrEqual(MIN_NORMAL)
    }
  })

  it.each(CVD)('keeps the sleep stages separable under %s', (kind) => {
    for (const [a, b] of pairs(stages.map((hex) => simulate(kind, hex)))) {
      expect(deltaE(a, b), `${a} vs ${b} under ${kind}`).toBeGreaterThanOrEqual(MIN_SIMULATED)
    }
  })

  it('meets WCAG contrast for text on cards', () => {
    expect(contrast(s['text-primary']!, s['surface-card']!)).toBeGreaterThanOrEqual(7)
    expect(contrast(s['text-secondary']!, s['surface-card']!)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(s['text-muted']!, s['surface-card']!)).toBeGreaterThanOrEqual(4.5)
  })

  it('meets non-text contrast for the accent on cards', () => {
    expect(contrast(s.accent!, s['surface-card']!)).toBeGreaterThanOrEqual(3)
  })

  // A no-data marker that shares its colour with the gridlines it sits among
  // fails "absence is visible" even though the mark is technically drawn.
  // Non-text contrast (WCAG 1.4.11) is the right tool for "visible against
  // its background"; deltaE is the right tool for "not confusable with the
  // other state marker", which is a foreground-vs-foreground question.
  it('meets non-text contrast for the no-data marker against the grid and the card surface', () => {
    const noData = chart['state-no-data']!
    expect(contrast(noData, chart.grid!), 'no-data vs grid').toBeGreaterThanOrEqual(3)
    expect(contrast(noData, s['surface-card']!), 'no-data vs surface-card').toBeGreaterThanOrEqual(3)
  })

  it('keeps the no-data marker distinguishable from the excluded-state marker', () => {
    const noData = chart['state-no-data']!
    expect(deltaE(noData, chart['state-excluded']!), 'no-data vs state-excluded').toBeGreaterThanOrEqual(MIN_SIMULATED)
  })
})
