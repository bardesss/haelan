import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cadenceOf, MIN_REPORTING_DATES, STALE_FLOOR_DAYS } from '../src/api/sourceCadence.ts'

// The eleventh browser-safe entry point. It exists because the staleness rule has two callers
// asking the same question of different histories: the settings card asks the server about a
// person's whole record, and a page asks about the range on screen, off the sourceMix already on
// the points it loaded. Two copies of one threshold is how a rule drifts, and a page that
// disagreed with the server about the same source on the same day is precisely the failure this
// subpath exists to prevent.
//
// sourceCadence.ts is import-free, the same contract metrics.ts holds itself to, so the
// allow-list below is empty rather than enumerated. It is arithmetic over dates and nothing else.

const SUBPATH = './source-cadence'
const TARGET = './src/api/sourceCadence.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

// The same scan coverage-signal-subpath.test.ts uses, and for the reason its comment gives: an
// `export ... from` re-export pulls a module in as surely as an import and carries no `import`
// keyword, so a scan for `^import` alone is blind to it.
const IMPORT_LINE = /^(?:import\s.*|export\s.*\bfrom\s*['"].*)$/gm

describe('the @haelan/core/source-cadence subpath', () => {
  it('is published, and points at the cadence module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
  })

  it('imports nothing at all, which is the whole of why it is browser safe', () => {
    // The file a future author would actually edit. Vitest runs under Node, where better-sqlite3
    // loads without complaint, so an import added here would pass every other test in this suite
    // and break only the bundle, silently. Adding one to reuse a helper from `query/` would drag
    // drizzle and better-sqlite3 into apps/web; put the helper here instead.
    const source = read('../src/api/sourceCadence.ts')
    expect([...source.matchAll(IMPORT_LINE)].map((m) => m[0])).toEqual([])
  })

  it('is the same rule the database reader applies, not a copy of it', () => {
    // query/sourceActivity.ts must delegate rather than reimplement: the drift this whole
    // subpath exists to prevent would reappear the moment that file grew its own arithmetic.
    const reader = read('../src/query/sourceActivity.ts')
    expect(reader).toContain("from '../api/sourceCadence.ts'")
    expect(reader).toContain('cadenceOf(')
    // The thresholds live in one file. A number here would be a second opinion.
    expect(reader).not.toContain('MIN_REPORTING_DATES =')
    expect(reader).not.toContain('STALE_FLOOR_DAYS =')
  })

  it('answers the same for the same dates however they are asked', () => {
    // The property both callers depend on: the page hands over dates gathered from chart points,
    // unsorted and repeated per metric, and the server hands over a sorted distinct list. They
    // must agree, or one surface calls a source stale while the other calls it fine.
    const dates = Array.from({ length: MIN_REPORTING_DATES + 6 }, (_, i) =>
      new Date(Date.parse('2026-01-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10))
    const asOf = '2026-03-01'
    const tidy = cadenceOf(dates, asOf)
    const messy = cadenceOf([...dates].reverse().flatMap((d) => [d, d]), asOf)
    expect(messy).toEqual(tidy)
    expect(tidy.status).toBe('stale')
    expect(STALE_FLOOR_DAYS).toBeGreaterThan(0)
  })
})
