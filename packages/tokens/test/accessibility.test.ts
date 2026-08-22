import { describe, it, expect } from 'vitest'
import { resolveChart, CHART_KEYS, STAGE_KEYS, SCALE_KEYS, type ChartToken } from '../src/chart.js'
import { resolveSemantic, SEMANTIC_KEYS, SURFACE_KEYS, TEXT_KEYS, THEMES, type SemanticToken } from '../src/semantic.js'
import { deltaE, toLab, hexToRgb, rgbToHex } from '../src/color/convert.js'
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

// app.css paints these on text: the active rail item and current wizard step
// (--accent-soft), the delta chips and form errors (--positive/--negative). Text
// answers to 4.5:1, not the 3:1 non-text floor - holding a tone token to the
// non-text floor while it renders 13.5px type is how a real failure ships green.
const TEXT_TONE_KEYS = ['accent-soft', 'positive', 'negative'] as const satisfies readonly SemanticToken[]
const NON_TEXT_KEYS = ['accent', 'focus'] as const satisfies readonly SemanticToken[]

// --accent-soft never sits on a bare surface: every rule that uses it also tints
// the background with --accent. Asserting against the untinted surface would
// measure a background that never renders, so the test composites the same mix
// the stylesheet does (color-mix in srgb over the surface).
const ACCENT_TINT = 0.13

// Mirrors OPACITY in apps/web/src/charts/base.ts. The band tokens are never
// painted at full strength, so full strength is not what a floor should measure.
const BASELINE_BAND_OPACITY = 0.5
const RANGE_BAND_OPACITY = 0.22

function tint(over: string, withColor: string, ratio: number): string {
  const [br, bg, bb] = hexToRgb(over)
  const [fr, fg, fb] = hexToRgb(withColor)
  return rgbToHex([br + (fr - br) * ratio, bg + (fg - bg) * ratio, bb + (fb - bb) * ratio])
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
  it.each(NON_TEXT_KEYS)('meets non-text contrast for %s on every surface', (token) => {
    for (const surface of SURFACE_KEYS) {
      expect(contrast(s[token], s[surface]), `${token} on ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })

  it.each(TEXT_TONE_KEYS)('meets WCAG text contrast for %s on every surface it labels', (token) => {
    for (const surface of SURFACE_KEYS) {
      // The accent tint travels with the token; the other tones are painted on
      // the bare surface (delta chips on the inset, form errors on the card).
      const background = token === 'accent-soft' ? tint(s[surface], s.accent, ACCENT_TINT) : s[surface]
      expect(contrast(s[token], background), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  // Good and bad are the one deliberately red/green pair in the system, in a
  // suite that exists because red and green collapse. The delta chip carries a
  // direction arrow too, but a redundant channel elsewhere is not a licence for
  // the colours themselves to be confusable.
  it('keeps the positive and negative tones separable under every simulation', () => {
    expect(minSeparation(s.positive, s.negative), 'positive vs negative').toBeGreaterThanOrEqual(MIN_STATE)
  })

  // Stage separation says the four stages are told apart from each other; it says
  // nothing about whether any of them can be seen at all. Hypnogram bars are not
  // a tiled band - each is centred in its own lane at 45% of the lane height
  // (Hypnogram.tsx), so card shows above and below every bar and each is an
  // isolated mark answering to the WCAG 1.4.11 floor. Two stages cannot meet it
  // from their fill: dark stage-deep measures 1.77 against its card and light
  // stage-rem 1.36, and lifting either means abandoning "deeper sleep, deeper
  // blue" (spec section 17), which is the thing that makes the ramp readable in
  // the first place. The marks are outlined instead (stage.ts, stageMark), so
  // what this layer has to guarantee is the outline colour - and it is asserted
  // here rather than beside the chart because the guarantee is a property of the
  // token, and a palette change is what would quietly withdraw it.
  it('holds the stage outline colour to the non-text floor against the card', () => {
    expect(contrast(chart.axis, s['surface-card']), 'axis (stage outline) vs surface-card').toBeGreaterThanOrEqual(3)
  })

  // The two washes. Neither is a mark in its own right - both are quiet fills
  // behind the data - so they answer to "actually a different colour from the
  // card", the same floor the border and the tooltip answer to, and they are
  // measured as composited rather than at full strength because neither is ever
  // painted at full strength.
  it('draws the baseline band as a band rather than as bare card', () => {
    const band = tint(s['surface-card'], chart['band-baseline'], BASELINE_BAND_OPACITY)
    expect(deltaE(band, s['surface-card']), 'baseline band vs surface-card').toBeGreaterThanOrEqual(5)
  })

  it('draws the heart-rate range band as a band rather than as bare card', () => {
    const band = tint(s['surface-card'], chart['stage-light'], RANGE_BAND_OPACITY)
    expect(deltaE(band, s['surface-card']), 'range band vs surface-card').toBeGreaterThanOrEqual(5)
  })

  // What a band must never do is swallow the series drawn on top of it. Stages
  // are absent here on purpose: a hypnogram has no baseline, and the two are
  // never drawn on the same chart.
  it('keeps both series legible where they cross the baseline band', () => {
    const band = tint(s['surface-card'], chart['band-baseline'], BASELINE_BAND_OPACITY)
    for (const token of ['series', 'series-alt'] as const) {
      expect(contrast(chart[token], band), `${token} vs baseline band`).toBeGreaterThanOrEqual(3)
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

// The suite's coverage used to end wherever someone stopped typing token names:
// `accent-soft` coloured the navigation and `band-baseline` backed every chart,
// and neither appeared in a single assertion. This guard does not prove a token
// is well tested - it proves nobody added one without deciding. A new token in
// semantic.ts or chart.ts fails here until it is listed, and listing it without
// writing an assertion is then a deliberate act rather than an oversight.
describe('assertion coverage', () => {
  const ASSERTED_SEMANTIC: readonly SemanticToken[] = [
    ...SURFACE_KEYS, ...TEXT_KEYS, ...TEXT_TONE_KEYS, ...NON_TEXT_KEYS, 'border-subtle',
  ]
  const ASSERTED_CHART: readonly ChartToken[] = [
    ...STAGE_KEYS, ...SCALE_KEYS,
    'series', 'series-alt', 'grid', 'axis', 'band-baseline',
    'state-excluded', 'state-no-data', 'tooltip-bg',
  ]

  it('holds every semantic token to at least one assertion', () => {
    expect([...SEMANTIC_KEYS].sort()).toEqual([...ASSERTED_SEMANTIC].sort())
  })

  it('holds every chart token to at least one assertion', () => {
    expect([...CHART_KEYS].sort()).toEqual([...ASSERTED_CHART].sort())
  })
})
