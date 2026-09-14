import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GRID_STACK_WIDTH } from '../src/ui/breakpoint.js'

// Comments stripped first: app.css's own prose names both `display: contents` and the wrapper
// classes while explaining them, and a drift check that read its own documentation would pass
// against a stylesheet that had lost the rule it documents.
const css = readFileSync(fileURLToPath(new URL('../src/app.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** Every `selector { ... }` pair in the file, media-query wrappers skipped by construction. */
function rules(source: string): { selector: string, body: string }[] {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1]!.trim(), body: m[2]!.trim() }))
}

const all = rules(css)

// Split on commas so a list stays a list: the collapse rule below carries four selectors and the
// question this file asks is about membership in it, not about the string it happens to be
// spelled as.
const parts = (selector: string): string[] => selector.split(',').map((s) => s.trim())

describe('the grid-collapse rule', () => {
  // What this exists to stop. `display: contents` takes the wrapper out of the box tree, so its
  // Card child becomes the grid item - and `.grid > *` still walks the real DOM, where that Card
  // is a child of the wrapper, not of `.grid`. Every such wrapper therefore needs its own
  // `> *` entry, and the only thing that noticed the missing ones was a reader seeing a page
  // scroll sideways. Nothing in the suite touched the rule at all: the sole exercise was
  // layout:check against whichever night the capture manifest happens to list first, currently
  // 2026-09-06, whose long "Efficiëntie" label is what made the overflow visible. A re-capture
  // ordering a different night first would have silently stopped testing it.
  it('covers every display: contents wrapper in the stylesheet', () => {
    const wrappers = all
      .filter((rule) => /display:\s*contents/.test(rule.body))
      .flatMap((rule) => parts(rule.selector))
    expect(wrappers.length, 'app.css should still declare display: contents somewhere').toBeGreaterThan(0)

    const collapse = all.find((rule) => /grid-column:\s*span 12\s*!important/.test(rule.body))
    expect(collapse, 'app.css should still carry a grid-collapse rule').toBeDefined()
    const collapsed = parts(collapse!.selector)

    for (const wrapper of wrappers) {
      expect(collapsed, `${wrapper} is display: contents, so ${wrapper} > * must collapse too`)
        .toContain(`${wrapper} > *`)
    }
  })

  // The rule is only worth having where the grid actually has more than one column to collapse
  // from, and that width is the one GRID_STACK_WIDTH names. Pinned here so a hand-edited media
  // query cannot quietly move the collapse away from the width the constant still claims.
  it('collapses at the width the constant names', () => {
    const media = css.match(/@media[^{]*\(max-width:\s*(\d+)px\)\s*\{[^{}]*\{[^{}]*grid-column:\s*span 12/)
    expect(media, 'the grid-collapse rule should sit inside a max-width media query').not.toBeNull()
    expect(Number(media![1])).toBe(GRID_STACK_WIDTH)
  })
})
