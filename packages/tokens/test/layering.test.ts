import { describe, it, expect } from 'vitest'
import { semantic, resolveSemantic, THEMES } from '../src/semantic.js'

describe('token layering', () => {
  // The layering rule is what keeps retheming a value swap instead of a rewrite.
  it.each(THEMES)('defines %s semantics only as primitive references', (theme) => {
    for (const [name, value] of Object.entries(semantic[theme])) {
      expect(value, `${theme}.${name} must reference a primitive, not a literal`).not.toMatch(/^(#|rgb|hsl)/)
    }
  })

  it.each(THEMES)('resolves every %s semantic token to a hex value', (theme) => {
    for (const [name, value] of Object.entries(resolveSemantic(theme))) {
      expect(value, `${theme}.${name}`).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('defines the same token names in both themes', () => {
    expect(Object.keys(semantic.dark).sort()).toEqual(Object.keys(semantic.light).sort())
  })

  it('throws when a semantic token points at a missing primitive', () => {
    expect(() => resolveSemantic('dark', { broken: 'blue.999' })).toThrow(/blue\.999/)
  })
})
