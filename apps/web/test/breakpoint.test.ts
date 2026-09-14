import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PHONE_MAX_WIDTH, GRID_STACK_WIDTH, PHONE_MEDIA_QUERY } from '../src/ui/breakpoint.js'

const css = readFileSync(fileURLToPath(new URL('../src/app.css', import.meta.url)), 'utf8')

describe('the breakpoint', () => {
  it('builds its media query from the constant', () => {
    expect(PHONE_MEDIA_QUERY).toBe(`(max-width: ${PHONE_MAX_WIDTH}px)`)
  })

  // The number lives in CSS and in TypeScript because a media query cannot read a custom property
  // and matchMedia cannot read a stylesheet. This is what keeps the two copies one value, and what
  // stops a third number appearing in app.css six months from now.
  it('allows no width in app.css other than the two named breakpoints', () => {
    const widths = [...css.matchAll(/@media[^{]*\(max-width:\s*(\d+)px\)/g)].map((m) => Number(m[1]))
    expect(widths.length, 'app.css should still have media queries').toBeGreaterThan(0)
    expect([...new Set(widths)].sort((a, b) => a - b)).toEqual([PHONE_MAX_WIDTH, GRID_STACK_WIDTH])
  })
})
