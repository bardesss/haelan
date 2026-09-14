import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// A test rather than a script, for the reason tools-doc-drift.test.ts gives: this asks a question
// about the code and needs nothing fetched and nothing spawned.
//
// `import.meta.main` reads like the obvious way to gate an entry point, which is why it arrived
// here once and will be offered again by anyone modernising these files on a machine where it
// works. It landed in Node 22.18; package.json declares `"node": ">=22.14"`. Below 22.18 it is
// `undefined`, so the gate is silently false and the entry simply never runs - `mcp.ts` served
// nothing and exited with an empty stdout, and `pnpm docs:tools` wrote no TOOLS.md and exited 0.
// Neither said a word about why. CI's floor leg is what caught it; this is what names it.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ROOTS = ['apps/server/src', 'packages/core/src', 'scripts']
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js']
const NEEDLE = 'import.meta.main'

const GUIDANCE = [
  '`import.meta.main` landed in Node 22.18, and package.json declares "node": ">=22.14".',
  'On the floor it is `undefined`, so the gate is silently false and the entry never runs.',
  'Use the portable form instead:',
  '',
  '  const entry = process.argv[1]',
  "  if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) { ... }",
  '',
  'Raising the engines floor past 22.18 is the only thing that makes the short form safe.',
].join('\n')

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) found.push(full)
  }
  return found
}

// The comments explaining why this rule exists have to name the thing the rule forbids, so a plain
// substring search would flag the fix as the bug. Only a use counts: a match with no `//` earlier
// on its line, on a line that is not a block-comment continuation.
function usesIn(file: string): string[] {
  const hits: string[] = []
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    const at = line.indexOf(NEEDLE)
    if (at === -1) return
    if (line.slice(0, at).includes('//')) return
    const trimmed = line.trimStart()
    if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    hits.push(`${relative(ROOT, file).replaceAll('\\', '/')}:${index + 1}`)
  })
  return hits
}

describe('the Node engines floor', () => {
  // Without this, a renamed or moved directory would leave the guard scanning nothing and passing
  // forever - the same vacuous green that let the original failure through.
  it.each(ROOTS)('has %s to scan, so the guard below is not passing over an empty set', (dir) => {
    expect(sourceFiles(join(ROOT, dir)).length).toBeGreaterThan(0)
  })

  it('is not undercut by import.meta.main, which is newer than the floor', () => {
    const offenders = ROOTS.flatMap((dir) => sourceFiles(join(ROOT, dir))).flatMap(usesIn)

    expect(offenders, GUIDANCE).toEqual([])
  })
})
