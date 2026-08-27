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

  // Dashboard and Sleep render the same hypnogram off the same query and the same night, so a
  // reader moving between them should not be told two different things about which night it is.
  // Dashboard said "last night" while Sleep said "most recent night"; Sleep's is the honest one,
  // since the range end can be months ago, and only one of the two can be right for both pages.
  it('word the sleep stages basis the same on both pages that render it', () => {
    for (const [locale, catalogue] of [['en', en], ['nl', nl]] as const) {
      expect(catalogue.dashboard.sleepStages.basis, locale).toBe(catalogue.sleep.sleepStages.basis)
    }
  })

  // One Dutch word per concept, not three. The moment of waking appeared as "wektijd" on a tile
  // label, "waaktijd" in the schedule basis beside it and "Ontwaakt" in that chart's own column
  // header. "Waaktijd" is the one that had to go regardless of consistency: it reads as time spent
  // awake, which is not what a bed and wake schedule states. The label/column split that remains
  // ("Wektijd" against "Ontwaakt") is the same noun-against-verb split the English carries in the
  // same two places ("Wake time" against "Woke"), so both languages say the same thing twice
  // rather than one of them saying it three ways.
  it('use one Dutch word for the moment of waking', () => {
    for (const path of paths(nl)) {
      const value = path.split('.').reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], nl)
      expect(String(value).toLowerCase(), path).not.toContain('waaktijd')
    }
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
