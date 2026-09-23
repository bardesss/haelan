import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { oneNightPerDate } from '../src/api/nights.ts'

// The twelfth browser-safe entry point. It exists because the glance payload (M9a) decides which
// night is last night on the server, and apps/web collapses the same duplicate nights on its own
// sleep pages. Two copies of "the longest recording of a date wins" is how the dashboard and the
// Sleep page would come to show two different nights for one date, so the rule lives once, here.
//
// nights.ts is import-free, the same contract metrics.ts and sourceCadence.ts hold themselves to,
// so the allow-list below is empty rather than enumerated.

const SUBPATH = './nights'
const TARGET = './src/api/nights.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

// The same scan source-cadence-subpath.test.ts uses, and for the reason its comment gives: an
// `export ... from` re-export pulls a module in as surely as an import and carries no `import`
// keyword, so a scan for `^import` alone is blind to it.
const IMPORT_LINE = /^(?:import\s.*|export\s.*\bfrom\s*['"].*)$/gm

describe('the @haelan/core/nights subpath', () => {
  it('is published, and points at the nights module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
  })

  it('imports nothing at all, which is the whole of why it is browser safe', () => {
    // The file a future author would actually edit. Vitest runs under Node, where better-sqlite3
    // loads without complaint, so an import added here would pass every other test in this suite
    // and break only the bundle, silently. Reaching into query/ for the NightSegment type would be
    // the tempting one, and would drag drizzle and better-sqlite3 into apps/web with it.
    const source = read('../src/api/nights.ts')
    expect([...source.matchAll(IMPORT_LINE)].map((m) => m[0])).toEqual([])
  })

  it('keeps the longest recording of a date', () => {
    const nights = oneNightPerDate([
      { localDate: '2026-08-20', startMs: 0, endMs: 100, sourceId: 'short' },
      { localDate: '2026-08-20', startMs: 0, endMs: 500, sourceId: 'long' },
      { localDate: '2026-08-19', startMs: 0, endMs: 50, sourceId: 'only' },
    ])
    expect(nights.map((n) => n.sourceId)).toEqual(['only', 'long'])
  })
})
