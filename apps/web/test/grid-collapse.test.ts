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

/**
 * The inside of the one media query that collapses the grid, found by the width it names rather
 * than by its position in the file.
 *
 * Both checks below used to walk the whole stylesheet and take the first match, which was correct
 * only for as long as exactly one rule in the file set `grid-column: span 12 !important`. A second
 * one now exists (the 901-1200px band), so "first" and "the collapse rule" are no longer the same
 * question, and the two only still agree by the order the declarations happen to sit in.
 */
function collapseBlock(): string {
  const at = css.indexOf(`@media (max-width: ${GRID_STACK_WIDTH}px)`)
  if (at === -1) return ''
  const open = css.indexOf('{', at)
  // Brace counting rather than a regex: the block holds nested `selector { ... }` rules, which is
  // exactly the shape a non-greedy `[^}]*}` stops at the wrong end of.
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return ''
}

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

    // Scoped to the collapse media query's own text before looking for the rule, rather than
    // taking the first `span 12 !important` in the file. There is now a second block that sets
    // `grid-column: span 12 !important` - the mid-band rule that halves the grid between 901px
    // and 1200px - and the previous `all.find` over the whole stylesheet would have returned
    // whichever of the two came first. It happens to still be this one, which is the problem: the
    // check would have gone on passing while asking its question of a rule that has nothing to do
    // with `display: contents` wrappers, and a reader reordering the file is all it would take to
    // make it assert against the wrong one silently.
    const block = collapseBlock()
    const collapse = rules(block).find((rule) => /grid-column:\s*span 12\s*!important/.test(rule.body))
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
    // Asked the other way round from the original: find the media query at GRID_STACK_WIDTH and
    // require it to carry the collapse, rather than find the first collapse and read the width off
    // whatever media query it sits in. The old direction passed as long as SOME max-width query
    // collapsed the grid, and the mid-band rule added beside it is a max-width query that sets
    // `grid-column: span 12 !important` too - so the original regex would have been satisfied by a
    // stylesheet where the 900px rule had been deleted outright.
    expect(css, `app.css should carry a max-width: ${GRID_STACK_WIDTH}px media query`)
      .toContain(`@media (max-width: ${GRID_STACK_WIDTH}px)`)
    expect(collapseBlock(), 'the query at GRID_STACK_WIDTH should be the one that collapses the grid')
      .toMatch(/grid-column:\s*span 12\s*!important/)
  })

  // The band between the collapse and a window wide enough for twelve columns, added with the
  // mid-band rule. Keyed on the inline style Card writes: `grid-column` set in the style attribute
  // outranks every stylesheet declaration that is not !important, so a mid-band rule missing it is
  // not a weaker rule, it is no rule at all - and nothing renders differently in a suite with no
  // layout engine. This is the only thing in the repository that would notice.
  it('marks every mid-band span override !important', () => {
    const at = css.indexOf('@media (width > 900px)')
    expect(at, 'app.css should carry the mid-band query').toBeGreaterThan(-1)
    let depth = 0
    let band = ''
    const open = css.indexOf('{', at)
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') {
        depth -= 1
        if (depth === 0) { band = css.slice(open + 1, i); break }
      }
    }
    const spans = [...band.matchAll(/grid-column:\s*span \d+([^;]*);/g)]
    expect(spans.length, 'the mid-band query should set at least one span').toBeGreaterThan(0)
    for (const span of spans) {
      expect(span[1], `"${span[0].trim()}" loses to Card's inline style without !important`)
        .toMatch(/!important/)
    }
  })
})
