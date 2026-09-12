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

/** A name CSS could style, which is the same shape definedClasses reads off a selector. */
const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * The expression inside each `className={...}`, matched by brace depth rather than up to the
 * first `}`.
 *
 * Depth is what keeps the next prop out. `aria-label={t('sectionsLabel')}` sits on the same line
 * as the className on Sidebar's nav, and a label, a translation key or an id is not a class list:
 * counting braces ends the expression exactly where it ends, so a sibling prop is never read as
 * one. It is the same care definedClasses takes on the other side, where reading past a selector
 * would turn `.14em` into a class.
 */
function classNameExpressions(source: string): string[] {
  const expressions: string[] = []
  for (const open of source.matchAll(/className=\{/g)) {
    const start = open.index! + open[0].length
    let depth = 1
    let end = start
    while (end < source.length && depth > 0) {
      if (source[end] === '{') depth++
      else if (source[end] === '}') depth--
      end++
    }
    expressions.push(source.slice(start, end - 1))
  }
  return expressions
}

/**
 * Every class name a component renders, from both forms the prop takes.
 *
 * `className="card"` and `className={collapsed ? 'rail rail-collapsed' : 'rail'}` put a class on
 * an element equally literally, and reading only the first left every conditional class
 * unguarded: renaming `rail-collapsed` in Sidebar and not in app.css kept this whole suite green
 * and shipped an unstyled rail. An expression is read by taking the quoted string literals out of
 * it, because however a class list is assembled a class name is a string literal somewhere inside
 * it; an arm that is not one (`collapsed ? 'sr-only' : undefined`) contributes nothing, which is
 * right, since it names no class.
 *
 * A lone identifier (`className={rowClassName}`) holds its literals a line away, so it resolves
 * against a const of that name in the same file. One hop and no further covers every such case
 * here, and a prop passed straight through (`className={className}` in router's Link) resolves to
 * nothing, correctly: those names belong to the callers, each scanned in its own turn.
 *
 * Tokens CSS could not name as a class are dropped rather than reported. Reaching one means the
 * reader has picked up something that was never a class list, and failing on it would put noise
 * where a real missing class should stand.
 */
function usedClasses(source: string): string[] {
  const lists = [...source.matchAll(/className="([^"]*)"/g)].map((match) => match[1]!)
  for (const expression of classNameExpressions(source)) {
    const identifier = expression.trim()
    const resolved = IDENTIFIER.test(identifier)
      ? new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\s*=([^\\n]*)`).exec(source)?.[1] ?? ''
      : expression
    // A `${...}` hole holds an expression rather than class text, so it is lifted out and read
    // beside the static template text it interrupts instead of being swallowed along with it.
    const holes: string[] = []
    const statics = resolved.replace(/\$\{([^{}]*)\}/g, (_, inner: string) => {
      holes.push(inner)
      return ' '
    })
    const scan = [statics, ...holes].join('\n')
    for (const literal of scan.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) {
      lists.push(literal[1] ?? literal[2] ?? literal[3]!)
    }
  }
  return lists.flatMap((list) => list.split(/\s+/)).filter((name) => CLASS_NAME.test(name))
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
      for (const name of usedClasses(readFileSync(file, 'utf8'))) {
        if (!defined.has(name)) missing.push(`${file.slice(SRC.length + 1)}: ${name}`)
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

  // The other half of the same guard, and the half that was missing: a reader blind to expressions
  // passes just as quietly as a selector parser that matches nothing. Every form below is one this
  // app ships, and the two negatives are the ways a widened reader goes wrong.
  it('reads class names out of an expression, not only out of a string', () => {
    const component = [
      "const rowClassName = session.excluded ? 'session-row session-row-excluded' : 'session-row'",
      "<nav className={collapsed ? 'rail rail-collapsed' : 'rail'} aria-label={t('sectionsLabel')}>",
      '  <span className="card" id="brand-heading" />',
      '  <span className={collapsed ? \'sr-only\' : undefined} />',
      '  <div className={rowClassName} />',
      '</nav>',
    ].join('\n')
    const used = new Set(usedClasses(component))

    expect(used.has('card')).toBe(true)
    // Both arms of a ternary, and an arm naming two classes split into both of them.
    expect(used.has('rail')).toBe(true)
    expect(used.has('rail-collapsed')).toBe(true)
    expect(used.has('sr-only')).toBe(true)
    // A variable reaches its literals through the const that holds them.
    expect(used.has('session-row')).toBe(true)
    expect(used.has('session-row-excluded')).toBe(true)

    // An arm that names no class adds none.
    expect(used.has('undefined')).toBe(false)
    // The two ways to read too much: the braced prop after className, and a quoted attribute that
    // is not className at all. Both are class-shaped here, so only the reader's aim excludes them.
    expect(used.has('sectionsLabel')).toBe(false)
    expect(used.has('brand-heading')).toBe(false)
  })
})
