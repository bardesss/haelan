import { readFileSync } from 'node:fs'
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

  // A pin comparing dashboard.sleepStages.basis with sleep.sleepStages.basis stood here. It went in
  // M9b with the key itself: the glance draws its hypnogram with Sleep's own chart label and, as its
  // screen-reader-only description, Sleep's own sleep.sleepStages.basis, so there is no second
  // wording left to drift from Sleep's.

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

  // README.md states this catalogue's size in prose, in two places, and it is the one fact about
  // the catalogue that lives in a file nothing here reads - everything above compares en.json and
  // nl.json against each other, never against a number typed by hand somewhere else. That number
  // has already gone stale twice on this branch, silently both times, because nothing checked it:
  // once when the branch that introduced it undercounted, and again when a later commit added two
  // keys and nobody updated the sentence two files away. Regexes anchored on the surrounding
  // words, not a bare \d+ - README.md has other numbers in it - and each match is asserted
  // non-null before its number is compared, so a reworded sentence fails loudly with a message
  // naming the sentence that moved, rather than the regex silently matching nothing and this test
  // vacuously passing the way the branch's earlier drift went uncaught.
  it('states its own key count correctly in both places README.md gives it', () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
    const total = paths(en).length

    const complete = readme.match(/both complete at (\d+) keys/)
    expect(complete, 'README.md: "both complete at N keys" was not found - has that sentence been reworded?')
      .not.toBeNull()
    expect(Number(complete![1]), 'README.md: "both complete at N keys"').toBe(total)

    const translate = readme.match(/translate its (\d+) keys/)
    expect(translate, 'README.md: "translate its N keys" was not found - has that sentence been reworded?')
      .not.toBeNull()
    expect(Number(translate![1]), 'README.md: "translate its N keys"').toBe(total)
  })
})
