import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { METRICS, DAILY_AGGS, metricSpec, SLEEP_METRICS } from '../src/derive/metrics.ts'

// The browser-safe half of this package. `.` reaches better-sqlite3 and @node-rs/argon2 through
// the barrel, native modules no bundle can carry, which is why apps/web could not depend on core
// at all and every page hand-copied the pieces of the catalogue it needed. `./metrics` is the
// second entry point that ends that: a page imports the catalogue, and unit, precision, direction
// and aggs have one definition again instead of one per page.
//
// The whole guarantee rests on a single fact, and this file is where the fact is checked rather
// than asserted in a comment: derive/metrics.ts imports nothing. A module with no imports has a
// module graph of exactly itself, so there is no path from this entry point to anything native,
// under any bundler and with no bundler configuration to get wrong. Add one import to that file
// and the guarantee is gone whether or not what it reaches happens to be pure today, which is why
// this rejects every import rather than trying to keep a list of the forbidden ones.

const SUBPATH = './metrics'
const TARGET = './src/derive/metrics.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

/**
 * The source with its comments removed, because the scan below looks for the word `import` and a
 * comment is entitled to say it. Naive on purpose: it would also strip a `//` inside a string
 * literal, and metrics.ts has none. If one ever appears the scan trips and this test goes red,
 * which is the failure direction to be naive in.
 */
const code = read('../src/derive/metrics.ts')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('the @haelan/core/metrics subpath', () => {
  it('is published, and points at the catalogue module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
    // The barrel is still the only other way in. `exports` without a wildcard is what stops a
    // page reaching, say, ../src/store/accounts.ts and dragging argon2 along behind it.
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', SUBPATH])
  })

  it('reaches no other module, which is the whole of why it is browser safe', () => {
    expect(code, 'derive/metrics.ts must not import anything').not.toMatch(/\bimport\b/)
    expect(code, 'derive/metrics.ts must not re-export from another module').not.toMatch(/\bfrom\s*['"]/)
    expect(code, 'derive/metrics.ts must not require anything').not.toMatch(/\brequire\s*\(/)
  })

  it('carries everything a page needs to describe a number', () => {
    // Named one by one rather than spot-checked, because this is the subpath's contract with
    // apps/web: a page states a headline number's unit and rounds it to the catalogue's
    // precision, and reads direction to know which way is better.
    for (const [metric, spec] of Object.entries(METRICS)) {
      expect(spec.unit, `${metric} has no unit`).toBeTypeOf('string')
      expect(spec.precision, `${metric} has no precision`).toBeTypeOf('number')
      expect(['up', 'down', 'neutral'], `${metric} has an unreadable direction`).toContain(spec.direction)
      expect(spec.aggs.length, `${metric} lists no aggs`).toBeGreaterThan(0)
      for (const agg of spec.aggs) expect(DAILY_AGGS).toContain(agg)
    }
  })

  it('carries the lookups a page reaches for by name', () => {
    expect(metricSpec('steps')).toBe(METRICS['steps'])
    expect(metricSpec('not_a_metric')).toBeUndefined()
    expect(SLEEP_METRICS.length).toBeGreaterThan(0)
  })
})
