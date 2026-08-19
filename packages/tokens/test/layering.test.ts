import { describe, it, expect } from 'vitest'
import { semantic, resolveSemantic, lookup, THEMES } from '../src/semantic.js'
import { chartTokens, resolveChart } from '../src/chart.js'
import { primitives, COLOR_GROUPS, type ColorGroup, type ColorPath } from '../src/primitives.js'
import { toLab, deltaE } from '../src/color/convert.js'

describe('token layering', () => {
  // The layering rule is what keeps retheming a value swap instead of a rewrite.
  it.each(THEMES)('defines %s semantics only as primitive references', (theme) => {
    for (const [name, value] of Object.entries(semantic[theme])) {
      expect(value, `${theme}.${name} must reference a primitive, not a literal`).not.toMatch(/^(#|rgb|hsl|oklch|lab|color)/)
    }
  })

  it.each(THEMES)('defines %s chart tokens only as primitive references', (theme) => {
    for (const [name, value] of Object.entries(chartTokens[theme])) {
      expect(value, `${theme}.${name} must reference a primitive, not a literal`).not.toMatch(/^(#|rgb|hsl|oklch|lab|color)/)
    }
  })

  it.each(THEMES)('resolves every %s semantic token to a hex value', (theme) => {
    for (const [name, value] of Object.entries(resolveSemantic(theme))) {
      expect(value, `${theme}.${name}`).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it.each(THEMES)('resolves every %s chart token to a hex value', (theme) => {
    for (const [name, value] of Object.entries(resolveChart(theme))) {
      expect(value, `${theme}.${name}`).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('defines the same token names in both themes', () => {
    expect(Object.keys(semantic.dark).sort()).toEqual(Object.keys(semantic.light).sort())
    expect(Object.keys(chartTokens.dark).sort()).toEqual(Object.keys(chartTokens.light).sort())
  })

  it('throws when a token points at a missing primitive', () => {
    expect(() => lookup('blue.999' as ColorPath)).toThrow(/blue\.999/)
    expect(() => lookup('mauve.400' as ColorPath)).toThrow(/mauve\.400/)
  })
})

describe('primitive naming', () => {
  // A step number is a position on a lightness ramp and nothing else. If the
  // numbers do not order by measured lightness they are not a shared vocabulary,
  // they are trivia every reader has to look up.
  it.each(COLOR_GROUPS)('orders %s steps by measured lightness', (group: ColorGroup) => {
    const steps = Object.entries(primitives[group])
      .map(([step, hex]) => ({ step: Number(step), L: toLab(hex).L, hex }))
      .sort((a, b) => a.step - b.step)
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1]!
      const next = steps[i]!
      expect(next.L, `${group}.${prev.step} (${prev.hex}, L=${prev.L.toFixed(1)}) must be lighter than ${group}.${next.step} (${next.hex}, L=${next.L.toFixed(1)})`)
        .toBeLessThan(prev.L)
    }
  })

  // Two names for one colour is how a palette grows a step nobody can choose
  // between. Surface ramps are exempt: adjacent page/card/inset steps are meant
  // to be barely separable, which is what makes them read as one surface family.
  it.each(COLOR_GROUPS)('gives every %s step a distinct colour where the steps are choices, not surfaces', (group: ColorGroup) => {
    const steps = Object.entries(primitives[group]).sort(([a], [b]) => Number(a) - Number(b))
    const SURFACE_STEPS = new Set(['50', '100', '150', '200', '900', '925', '950', '975'])
    for (let i = 1; i < steps.length; i++) {
      const [prevStep, prevHex] = steps[i - 1]!
      const [step, hex] = steps[i]!
      if (group === 'slate' && SURFACE_STEPS.has(prevStep) && SURFACE_STEPS.has(step)) continue
      expect(deltaE(prevHex, hex), `${group}.${prevStep} vs ${group}.${step}`).toBeGreaterThan(6)
    }
  })

  it('keeps role names and theme names out of layer one', () => {
    for (const group of COLOR_GROUPS) {
      for (const step of Object.keys(primitives[group])) {
        expect(step, `${group}.${step}`).toMatch(/^\d+$/)
      }
    }
  })
})
