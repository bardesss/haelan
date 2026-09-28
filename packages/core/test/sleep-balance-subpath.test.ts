import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { balanceOf } from '../src/api/sleepBalance.ts'

// The browser-safe entry point for the sleep balance. It exists because the Sleep page and the
// night page (M10a) state the same balance, one in apps/web and one on the server; two copies of
// "sign each night against the zero line" is how the two pages would come to disagree about the
// same week, so the rule lives once, here.
//
// sleepBalance.ts is import-free, the same contract metrics.ts and nights.ts hold themselves to,
// so the allow-list below is empty rather than enumerated.

const SUBPATH = './sleep-balance'
const TARGET = './src/api/sleepBalance.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

// The same scan source-cadence-subpath.test.ts uses, and for the reason its comment gives: an
// `export ... from` re-export pulls a module in as surely as an import and carries no `import`
// keyword, so a scan for `^import` alone is blind to it.
const IMPORT_LINE = /^(?:import\s.*|export\s.*\bfrom\s*['"].*)$/gm

describe('the @haelan/core/sleep-balance subpath', () => {
  it('is published, and points at the sleep balance module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
  })

  it('imports nothing at all, which is the whole of why it is browser safe', () => {
    // Reaching into query/ for GlanceBaseline would be the tempting import, and would drag
    // drizzle and better-sqlite3 into apps/web with it; the module states the one field shape it
    // reads instead.
    const source = read('../src/api/sleepBalance.ts')
    expect([...source.matchAll(IMPORT_LINE)].map((m) => m[0])).toEqual([])
  })

  it('signs each night against the zero line', () => {
    expect(balanceOf([400, null, 500], 450)).toEqual({ values: [-50, null, 50], total: 0 })
  })
})
