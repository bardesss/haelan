import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PHONE_MAX_WIDTH, GRID_STACK_WIDTH, MID_BAND_MAX_WIDTH, PHONE_MEDIA_QUERY } from '../src/ui/breakpoint.js'

const css = readFileSync(fileURLToPath(new URL('../src/app.css', import.meta.url)), 'utf8')

describe('the breakpoint', () => {
  it('builds its media query from the constant', () => {
    expect(PHONE_MEDIA_QUERY).toBe(`(max-width: ${PHONE_MAX_WIDTH}px)`)
  })

  // The number lives in CSS and in TypeScript because a media query cannot read a custom property
  // and matchMedia cannot read a stylesheet. This is what keeps the two copies one value, and what
  // stops a third number appearing in app.css six months from now.
  //
  // Every pixel length in every `@media` prelude, not every `max-width:` in one. The narrower read
  // saw one spelling of a breakpoint and was blind to the rest: `(min-width: 621px)` is a third
  // number in this stylesheet by any reading - it is the complement of 620 written a second time,
  // and moving the constant would leave it behind - and the old regex passed it without a word.
  // The range syntax `(width <= 620px)` is the same story in a third spelling. Reading the whole
  // prelude needs no list of the spellings a width can take, which is the point: a spelling nobody
  // anticipated is the one that gets through.
  //
  // A pixel length that is genuinely not a width (`(min-height: 500px)`, say) fails this too. That
  // is intended rather than tolerated: it would be a magic number in a media query with nothing
  // naming it, which is the thing being forbidden here, and the failure says which number it found.
  it('allows no length in an app.css media query other than the two named breakpoints', () => {
    const preludes = [...css.matchAll(/@media([^{]*)\{/g)].map((m) => m[1]!)
    expect(preludes.length, 'app.css should still have media queries').toBeGreaterThan(0)
    const widths = preludes.flatMap((prelude) => [...prelude.matchAll(/(\d+)px/g)].map((m) => Number(m[1])))
    expect(widths.length, 'app.css media queries should still name a width').toBeGreaterThan(0)
    // Three now, not two. The mid band added MID_BAND_MAX_WIDTH; its lower edge is spelled
    // `width > GRID_STACK_WIDTH` rather than `min-width: 901px` precisely so this list does not
    // grow a fourth entry that is really the second one plus one, which is the duplication the
    // comment above warns about.
    expect([...new Set(widths)].sort((a, b) => a - b))
      .toEqual([PHONE_MAX_WIDTH, GRID_STACK_WIDTH, MID_BAND_MAX_WIDTH])
  })
})
