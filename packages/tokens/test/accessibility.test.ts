import { describe, it, expect } from 'vitest'
import { resolveChart, STAGE_KEYS, SCALE_KEYS } from '../src/chart.js'
import { resolveSemantic, SURFACE_KEYS, TEXT_KEYS, THEMES } from '../src/semantic.js'
import { deltaE, toLab } from '../src/color/convert.js'
import { simulate, minSeparation, CVD_KINDS } from '../src/color/cvd.js'
import { contrast } from '../src/color/contrast.js'

const MIN_NORMAL = 25
const MIN_SIMULATED = 18
// State markers answer a question the reader asks deliberately ("why is there
// nothing here?"), so they carry margin over the categorical floor rather than
// sitting on it.
const MIN_STATE = MIN_SIMULATED + 2

const TEXT_MIN: Record<(typeof TEXT_KEYS)[number], number> = {
  'text-primary': 7,
  'text-secondary': 4.5,
  'text-muted': 4.5,
  'text-faint': 4.5,
}

function pairs(values: string[]): [string, string][] {
  return values.flatMap((a, i) => values.slice(i + 1).map((b) => [a, b] as [string, string]))
}

describe.each(THEMES)('%s palette accessibility', (theme) => {
  const chart = resolveChart(theme)
  const stages = STAGE_KEYS.map((k) => chart[k])
  const scale = SCALE_KEYS.map((k) => chart[k])
  const s = resolveSemantic(theme)

  it('separates the sleep stages in normal vision', () => {
    for (const [a, b] of pairs(stages)) {
      expect(deltaE(a, b), `${a} vs ${b}`).toBeGreaterThanOrEqual(MIN_NORMAL)
    }
  })

  it.each(CVD_KINDS)('keeps the sleep stages separable under %s', (kind) => {
    for (const [a, b] of pairs(stages.map((hex) => simulate(kind, hex)))) {
      expect(deltaE(a, b), `${a} vs ${b} under ${kind}`).toBeGreaterThanOrEqual(MIN_SIMULATED)
    }
  })

  // Every tier over every surface, not just the card: a rail label and a card
  // label are the same text at the same size, and the reader does not know
  // which surface the designer had in mind.
  it.each(TEXT_KEYS)('meets WCAG text contrast for %s on every surface', (tier) => {
    for (const surface of SURFACE_KEYS) {
      expect(contrast(s[tier], s[surface]), `${tier} on ${surface}`).toBeGreaterThanOrEqual(TEXT_MIN[tier])
    }
  })

  // WCAG 1.4.11: anything carrying meaning without text has to clear 3:1 against
  // whatever it is drawn on. `focus` is included even though nothing consumes it
  // yet, because a focus ring is exactly this kind of mark and the milestone that
  // builds one should inherit a constrained token rather than an unchecked one.
  it.each(['accent', 'focus', 'positive', 'negative'] as const)('meets non-text contrast for %s on every surface', (token) => {
    for (const surface of SURFACE_KEYS) {
      expect(contrast(s[token], s[surface]), `${token} on ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('draws a card border that is actually a different colour from the card', () => {
    expect(deltaE(s['border-subtle'], s['surface-card']), 'border-subtle vs surface-card').toBeGreaterThanOrEqual(5)
  })

  it('meets non-text contrast for the chart series against the grid and the card', () => {
    for (const token of ['series', 'series-alt'] as const) {
      expect(contrast(chart[token], chart.grid), `${token} vs grid`).toBeGreaterThanOrEqual(3)
      expect(contrast(chart[token], s['surface-card']), `${token} vs surface-card`).toBeGreaterThanOrEqual(3)
    }
  })

  // Axis labels are text, at font-size 9, so they answer to the text floor and
  // not the non-text one.
  it('meets WCAG text contrast for axis labels on the card', () => {
    expect(contrast(chart.axis, s['surface-card']), 'axis vs surface-card').toBeGreaterThanOrEqual(4.5)
  })

  it('keeps tooltip text legible on the tooltip surface', () => {
    expect(contrast(s['text-muted'], chart['tooltip-bg']), 'text-muted vs tooltip-bg').toBeGreaterThanOrEqual(4.5)
    expect(deltaE(chart['tooltip-bg'], s['surface-card']), 'tooltip-bg vs surface-card').toBeGreaterThanOrEqual(5)
  })

  it('keeps the second categorical series separable from the first', () => {
    expect(minSeparation(chart.series, chart['series-alt']), 'series vs series-alt').toBeGreaterThanOrEqual(MIN_STATE)
  })

  // A no-data marker that shares its colour with the gridlines it sits among
  // fails "absence is visible" even though the mark is technically drawn.
  // Non-text contrast (WCAG 1.4.11) is the right tool for "visible against
  // its background"; deltaE is the right tool for "not confusable with the
  // other marks on the chart", which is a foreground-vs-foreground question.
  it.each(['state-no-data', 'state-excluded'] as const)('meets non-text contrast for %s against the grid and the card surface', (token) => {
    expect(contrast(chart[token], chart.grid), `${token} vs grid`).toBeGreaterThanOrEqual(3)
    expect(contrast(chart[token], s['surface-card']), `${token} vs surface-card`).toBeGreaterThanOrEqual(3)
  })

  // Absence and exclusion mean different things (a reading that never existed
  // versus one that was thrown out), so they have to be separable rather than
  // merely different, and separable to a reader with any common dichromacy.
  // The other entries are every colour that can share a chart with the marker.
  const COMPANIONS = ['state-excluded', 'series', 'series-alt', 'stage-light', 'stage-awake', 'stage-deep', 'stage-rem'] as const
  it.each(COMPANIONS)('keeps the no-data marker distinguishable from %s in normal vision and under every simulation', (other) => {
    expect(minSeparation(chart['state-no-data'], chart[other]), `state-no-data vs ${other}`).toBeGreaterThanOrEqual(MIN_STATE)
  })

  it.each(SCALE_KEYS)('keeps the no-data marker distinguishable from %s', (stop) => {
    expect(minSeparation(chart['state-no-data'], chart[stop]), `state-no-data vs ${stop}`).toBeGreaterThanOrEqual(MIN_STATE)
  })

  // A sequential scale that is not monotonic in lightness is not a scale: the
  // reader ranks the cells by how dark they look, whatever order the stops were
  // declared in.
  it('runs the sequential scale monotonically through lightness', () => {
    const lightness = scale.map((hex) => toLab(hex).L)
    const direction = Math.sign((lightness.at(-1) ?? 0) - (lightness[0] ?? 0))
    expect(direction, 'scale must not start and end at the same lightness').not.toBe(0)
    for (let i = 1; i < lightness.length; i++) {
      const step = ((lightness[i] ?? 0) - (lightness[i - 1] ?? 0)) * direction
      expect(step, `${SCALE_KEYS[i - 1]} to ${SCALE_KEYS[i]}`).toBeGreaterThanOrEqual(8)
    }
  })

  it('separates the ends of the sequential scale', () => {
    expect(deltaE(scale[0]!, scale.at(-1)!), 'scale-1 vs scale-5').toBeGreaterThanOrEqual(40)
  })

  it('keeps the low end of the sequential scale visible as a cell rather than as bare card', () => {
    expect(deltaE(scale[0]!, s['surface-card']), 'scale-1 vs surface-card').toBeGreaterThanOrEqual(10)
  })
})
