import { describe, it, expect } from 'vitest'
import { semantic, resolveSemantic, lookup, THEMES } from '../src/semantic.js'
import { chartTokens, resolveChart } from '../src/chart.js'
import { primitives, COLOR_GROUPS, type ColorGroup, type ColorPath } from '../src/primitives.js'
import { toLab, deltaE } from '../src/color/convert.js'

// "Not a hex literal" was the whole of the old check, which let through every violation that
// matters: a token naming another token, a token naming nothing, a bare word. What the layering
// rule actually says is that a value at layer two or three is a reference into layer one, so
// that is what gets asserted - a group from COLOR_GROUPS and a step that exists in it.
function isPrimitiveRef(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const [group, step, ...rest] = value.split('.')
  if (rest.length > 0 || !group || !step) return false
  if (!COLOR_GROUPS.includes(group as ColorGroup)) return false
  return Object.hasOwn(primitives[group as ColorGroup], step)
}

describe('the layering guard itself', () => {
  // A guard nobody has watched fail is a guard nobody knows the shape of.
  it('accepts a real primitive reference', () => {
    expect(isPrimitiveRef('blue.500')).toBe(true)
  })

  it('rejects a literal colour, which is the violation the old check could see', () => {
    for (const literal of ['#4F8FF7', 'rgb(79,143,247)', 'oklch(70% .1 250)']) {
      expect(isPrimitiveRef(literal), literal).toBe(false)
    }
  })

  // The violations the old check could not see. A chart token naming a semantic token is the
  // one that matters most: it is layer three reaching sideways instead of down, and it would
  // have read as perfectly fine to a regex looking for a leading '#'.
  it('rejects a token naming another token rather than a primitive', () => {
    expect(isPrimitiveRef('accent')).toBe(false)
    expect(isPrimitiveRef('surface-card')).toBe(false)
  })

  it('rejects a reference into a group or step that does not exist', () => {
    expect(isPrimitiveRef('blue.999')).toBe(false)
    expect(isPrimitiveRef('mauve.400')).toBe(false)
    expect(isPrimitiveRef('blue')).toBe(false)
    expect(isPrimitiveRef('blue.500.dark')).toBe(false)
  })
})

describe('token layering', () => {
  // The layering rule is what keeps retheming a value swap instead of a rewrite.
  it.each(THEMES)('defines %s semantics only as primitive references', (theme) => {
    for (const [name, value] of Object.entries(semantic[theme])) {
      expect(isPrimitiveRef(value), `${theme}.${name} must reference a primitive: got ${String(value)}`).toBe(true)
    }
  })

  it.each(THEMES)('defines %s chart tokens only as primitive references', (theme) => {
    for (const [name, value] of Object.entries(chartTokens[theme])) {
      expect(isPrimitiveRef(value), `${theme}.${name} must reference a primitive: got ${String(value)}`).toBe(true)
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
