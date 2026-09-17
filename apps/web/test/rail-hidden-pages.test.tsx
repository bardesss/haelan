// No happy-dom here, deliberately. This file renders to a string and needs no DOM, and under
// happy-dom `import.meta.url` is not a file: URL - so fileURLToPath refuses it and the catalogue
// read below throws "The URL must be of scheme file" rather than checking anything.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sidebar, RAIL_PATHS, PAGE_DATA_TYPES, railItemsFor } from '../src/components/Sidebar.js'

/**
 * The catalogue's own ids, read out of its source.
 *
 * Read rather than imported because `@haelan/core` publishes no `./catalogue` subpath, and adding
 * one to satisfy a test would be a new public entry point bought for nothing. Reading the source
 * is what css-classes.test.ts and grid-collapse.test.ts already do for the same kind of question.
 */
const catalogueIds = (): Set<string> => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../packages/core/src/api/catalogue.ts', import.meta.url)),
    'utf8',
  ).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ' ')
  return new Set([...source.matchAll(/listable\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]!))
}

/**
 * A page a person has switched off does not sit in the rail.
 *
 * The mechanism for switching one off already existed: data types are excluded per person, from
 * Settings and from the wizard, and the exclusion stops the sync. What it never did was remove the
 * page, so somebody who had turned nutrition off still had Nutrition in the rail, permanently, and
 * opening it showed an empty state explaining that nothing had been logged.
 *
 * Hidden from the rail rather than removed from the router, deliberately. A bookmark, a deep link
 * and a browser history entry all keep working, and `RAIL_PATHS` stays the complete static list -
 * so shell.test.tsx's assertion that the rail and the router name exactly the same paths keeps
 * proving what it was written to prove, instead of being weakened to a subset check to accommodate
 * this.
 */
describe('which pages the rail offers', () => {
  it('names only data types the catalogue actually has', () => {
    // A typo here is invisible in the worst way: an id nothing matches can never be excluded, so
    // the page it guards would simply never hide and nobody would know why.
    const known = catalogueIds()
    expect(known.size, 'the catalogue scan found nothing, so the check below is vacuous').toBeGreaterThan(20)
    for (const [path, ids] of Object.entries(PAGE_DATA_TYPES)) {
      for (const id of ids) expect(known, `${path} names ${id}`).toContain(id)
    }
  })

  it('only guards paths the rail actually links to', () => {
    for (const path of Object.keys(PAGE_DATA_TYPES)) {
      expect(RAIL_PATHS, path).toContain(path)
    }
  })

  it('offers every page when nothing is excluded', () => {
    expect(railItemsFor(new Set()).map((item) => item.path)).toEqual([...RAIL_PATHS])
  })

  it('drops a page whose every data type the person turned off', () => {
    const paths = railItemsFor(new Set(PAGE_DATA_TYPES['/nutrition'])).map((item) => item.path)
    expect(paths).not.toContain('/nutrition')
  })

  // Partial exclusion keeps the page. Turning off one of the types a page draws leaves it with
  // something to draw, and hiding it would take away a page that still works.
  it('keeps a page whose data types are only partly turned off', () => {
    const [first] = PAGE_DATA_TYPES['/nutrition']!
    const paths = railItemsFor(new Set([first!])).map((item) => item.path)
    expect(paths).toContain('/nutrition')
  })

  it('never hides a page it was given no data types for', () => {
    // Settings is the case that matters: it is how a person turns an exclusion back off again, and
    // a rail that could hide it would be a one-way door.
    const everything = catalogueIds()
    const paths = railItemsFor(everything).map((item) => item.path)
    expect(paths).toContain('/settings')
    expect(paths).toContain('/')
  })

  it('renders the rail without the hidden page', () => {
    const html = renderToStaticMarkup(
      <Sidebar person="Wilma" active="/" onSignOut={() => {}}
        excludedDataTypes={new Set(PAGE_DATA_TYPES['/nutrition'])} />,
    )
    expect(html).not.toContain('href="/nutrition"')
    expect(html).toContain('href="/sleep"')
  })
})
