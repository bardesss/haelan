import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { joinWords, numberWord } from '../number-words.mjs'

// The README and the landing page describe the same program to two different readers, and they are
// meant to read differently: one is documentation, the other is a poster. What they must not do is
// disagree about facts. These guards pin only the countable claims - how many pages, how many tools
// - and leave every sentence around them alone.
//
// Each count is derived from the code that defines it rather than from the other document, so a
// ninth page fails here even if somebody diligently updated both files to say "nine" and the app
// actually has ten.
const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8').replaceAll('\r\n', '\n')

const readme = read('README.md')
const landing = read('site/index.html')

/**
 * The pages a reader can navigate to, named by the component each route renders.
 *
 * Read as text rather than imported: `apps/web/src/routes.tsx` pulls in every page component and
 * with them the whole chart stack, which is a heavy and fragile thing to drag into a test about
 * two documents. The shape it matches is the one the file has had since the table was written, and
 * the count assertion below fails loudly if this ever silently matches nothing.
 */
function pageNames() {
  const routes = read('apps/web/src/routes.tsx')
  const table = /export const ROUTES[^=]*=\s*\[([\s\S]*?)\n\]/.exec(routes)
  expect(table, 'the ROUTES table in apps/web/src/routes.tsx no longer looks the way this test reads it').not.toBeNull()

  return [...table![1].matchAll(/\{\s*path:\s*(?:'([^']*)'|(\w+)),\s*element:\s*<(\w+)/g)]
    // A parameterised path is a detail page reached from a list, not a page in the rail, and
    // neither Settings nor Account - the two halves of what used to be one settings page - is one
    // of the eight either document counts.
    .filter(([, literal, constant]) => constant === undefined && !literal!.includes(':'))
    .map(([, , , component]) => component!)
    .filter((component) => component !== 'Settings' && component !== 'Account')
}

/**
 * How many tools ship, taken from the heading `pnpm docs:tools` generates from `CATALOGUE.length`.
 *
 * Through TOOLS.md rather than by importing the catalogue directly, for the same reason as above -
 * and it costs nothing in rigour, because apps/server/test/tools-doc-drift.test.ts already fails
 * when TOOLS.md and the catalogue disagree. The chain is catalogue to TOOLS.md to here.
 */
function toolCount() {
  const heading = /^## Tools \((\d+)\)$/m.exec(read('TOOLS.md'))
  expect(heading, 'TOOLS.md has no generated tool-count heading').not.toBeNull()
  return Number(heading![1])
}

describe('the pages both surfaces claim', () => {
  it('are the pages the app actually routes to', () => {
    const pages = pageNames()
    expect(pages.length, 'the ROUTES regex matched nothing recognisable').toBeGreaterThan(1)

    const sentence = joinWords(pages)
    expect(readme, 'the README lists different pages than the app has').toContain(sentence)
    expect(landing, 'the landing page lists different pages than the app has').toContain(sentence)
  })

  it('are counted correctly in the prose on both', () => {
    // A count written out in words is the part nobody rereads when a page is added. Both documents
    // open their page section with the number, so both are checked against the table.
    const word = numberWord(pageNames().length)
    const capitalised = word[0]!.toUpperCase() + word.slice(1)

    expect(readme).toContain(`${capitalised} pages`)
    expect(landing).toContain(`${capitalised} pages`)
  })
})

describe('the tool count in the README', () => {
  it('is the number of tools that ship', () => {
    const word = numberWord(toolCount())
    const capitalised = word[0]!.toUpperCase() + word.slice(1)
    expect(readme, `the catalogue ships ${toolCount()} tools`).toContain(`${capitalised} typed tools`)
  })

  it('is a number the landing page never repeats', () => {
    // The landing page points at TOOLS.md instead of naming a figure, which is the other way to
    // never be wrong. This pins that choice: adding a count to the poster would add a third place
    // to update, and this test is cheaper than remembering.
    const tools = landing.slice(landing.indexOf('The tools'), landing.indexOf('</section>', landing.indexOf('The tools')))
    expect(tools).not.toMatch(/\b(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen)\b/i)
    expect(tools).not.toMatch(/\b\d+ (?:typed )?tools\b/)
  })
})
