import { describe, it, expect } from 'vitest'
import en from '../src/i18n/en.json' with { type: 'json' }
import nl from '../src/i18n/nl.json' with { type: 'json' }

// A key present in one catalogue and missing from the other renders as the raw key to whoever
// chose that language. This catches the missing half; nothing here can catch a wrong translation,
// and the M3 spec's risk 4 records that.
function paths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => paths(child, prefix === '' ? key : `${prefix}.${key}`))
}

describe('the message catalogues', () => {
  it('carry exactly the same keys in both languages', () => {
    expect(paths(nl).sort()).toEqual(paths(en).sort())
  })

  it('leave no value empty, which renders as a blank label rather than a visible mistake', () => {
    for (const [locale, catalogue] of [['en', en], ['nl', nl]] as const) {
      for (const path of paths(catalogue)) {
        const value = path.split('.').reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], catalogue)
        expect(typeof value === 'string' && value.trim() !== '', `${locale}: ${path}`).toBe(true)
      }
    }
  })
})
