import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const APP_CSS = fileURLToPath(new URL('../src/app.css', import.meta.url))

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFiles(path)
    return extname(entry.name) === '.tsx' ? [path] : []
  })
}

/**
 * Every class name app.css actually styles.
 *
 * Read off the selector text rather than the whole file, because a declaration value carries dots
 * of its own (`letter-spacing: .14em` would otherwise register a class called `14em`). The text
 * immediately before each `{` is a selector list or an at-rule prelude and nothing else, since a
 * declaration has no brace, so capturing that and nothing else keeps property values out.
 */
function definedClasses(css: string): Set<string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const names = new Set<string>()
  for (const match of withoutComments.matchAll(/([^{}]+)\{/g)) {
    for (const name of match[1]!.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) names.add(name[1]!)
  }
  return names
}

describe('the stylesheet and the markup agree', () => {
  /**
   * A class name is an interface between a component and app.css, and it is the one interface in
   * this app that fails silently: happy-dom applies no stylesheet, renderToStaticMarkup applies
   * no stylesheet, so a component naming a class nobody wrote renders, passes every assertion in
   * the suite, and reaches a reader as unstyled markup. This branch invented three of them.
   */
  it('styles every class name a component renders', () => {
    const defined = definedClasses(readFileSync(APP_CSS, 'utf8'))
    const missing: string[] = []
    for (const file of tsxFiles(SRC)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/className="([^"]*)"/g)) {
        for (const name of match[1]!.split(/\s+/).filter((n) => n !== '')) {
          if (!defined.has(name)) missing.push(`${file.slice(SRC.length + 1)}: ${name}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  // Guards the reader above rather than the markup: a selector parser that quietly matched
  // nothing would make the test pass for every class name anyone could invent.
  it('reads real class names out of the stylesheet', () => {
    const defined = definedClasses(readFileSync(APP_CSS, 'utf8'))
    expect(defined.has('card')).toBe(true)
    expect(defined.has('sr-only')).toBe(true)
    // Inside a media query, so it only appears if nested blocks are handled.
    expect(defined.has('copy-field')).toBe(true)
    // A length in a declaration value, not a class: `.setup-step > p { margin: 0 0 var(--space-4) }`
    // sits beside `letter-spacing: -.01em` in the same file.
    expect(defined.has('01em')).toBe(false)
  })
})
