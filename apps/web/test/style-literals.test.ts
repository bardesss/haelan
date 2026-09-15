import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const app = readFileSync(fileURLToPath(new URL('../src/app.css', import.meta.url)), 'utf8')
const site = readFileSync(fileURLToPath(new URL('../../../site/site.css', import.meta.url)), 'utf8')

// The display scale is deliberately page-local: a dashboard has no use for 4rem type, and the
// landing page is its only consumer. These three leadings belong to it and are the only literals
// either stylesheet is allowed to carry.
const DISPLAY_LEADINGS = new Set(['.9', '1.04', '1.25'])

/**
 * Every value either stylesheet gives `property` that is not a token reference.
 *
 * The whole value, not the numeric part of it. Reading `([0-9.]+)` saw `font-weight: 600` and was
 * blind to `font-weight: bold`, which is the same literal spelled as a keyword: it names a weight
 * without saying which of the three it means, and a stylesheet that carries one is back to having
 * no vocabulary, which is the state these tokens exist to leave. `line-height: normal` is the same
 * shape on the other property.
 *
 * Inverted rather than enumerated - anything that is not `var(...)` fails - because the list of
 * ways to write a weight is not one this test should have to keep up to date, and the fix for any
 * of them is identical: name the token.
 *
 * Comments are stripped first. They are prose about these very properties (the token comment in
 * packages/tokens/src/primitives.ts quotes values, and so do several here), and a sentence naming
 * a value is not a declaration setting one.
 */
function literals(css: string, property: 'font-weight' | 'line-height'): string[] {
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  return [...declarations.matchAll(new RegExp(`${property}\\s*:\\s*([^;}]+)`, 'g'))]
    .map((m) => m[1]!.trim())
    .filter((value) => !value.startsWith('var(--'))
}

describe('stylesheet literals', () => {
  it('has no bare font-weight in either stylesheet', () => {
    expect(literals(app, 'font-weight')).toEqual([])
    expect(literals(site, 'font-weight')).toEqual([])
  })

  it('has no bare line-height outside the landing page display scale', () => {
    expect(literals(app, 'line-height')).toEqual([])
    expect(literals(site, 'line-height').filter((v) => !DISPLAY_LEADINGS.has(v))).toEqual([])
  })
})
