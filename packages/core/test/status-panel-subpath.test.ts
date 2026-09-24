import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { shownByDefault } from '../src/api/statusPanel.ts'

// The thirteenth browser-safe entry point. It exists because "is this source shown in the status
// panel by default" has two callers: composeStatus on the server, deciding what the panel lists,
// and the source list in apps/web, deciding whether a source with no explicit choice draws its
// "Show in status panel" switch checked. A switch that disagreed with the panel about the same
// source would be a control that lies about what it controls, so the rule lives once, here, and
// the web app imports it rather than restating thirty days. The response types ride along, so the
// web's data hook reads the shape composeStatus builds instead of a hand-kept mirror of it.
//
// statusPanel.ts is import-free, the same contract sourceCadence.ts and nights.ts hold themselves
// to, so the allow-list below is empty rather than enumerated.

const SUBPATH = './status-panel'
const TARGET = './src/api/statusPanel.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

// The same scan source-cadence-subpath.test.ts uses, and for the reason its comment gives: an
// `export ... from` re-export pulls a module in as surely as an import and carries no `import`
// keyword, so a scan for `^import` alone is blind to it.
const IMPORT_LINE = /^(?:import\s.*|export\s.*\bfrom\s*['"].*)$/gm

describe('the @haelan/core/status-panel subpath', () => {
  it('is published, and points at the status panel module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
  })

  it('imports nothing at all, which is the whole of why it is browser safe', () => {
    // Vitest runs under Node, where better-sqlite3 loads without complaint, so an import added
    // here would pass every other test in this suite and break only the bundle, silently.
    const source = read('../src/api/statusPanel.ts')
    expect([...source.matchAll(IMPORT_LINE)].map((m) => m[0])).toEqual([])
  })

  it('carries the default rule the web app imports', () => {
    expect(shownByDefault('2026-09-01', '2026-09-24')).toBe(true)
    expect(shownByDefault(null, '2026-09-24')).toBe(false)
  })
})
