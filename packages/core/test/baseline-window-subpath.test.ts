import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { baselineWindow, BASELINE_WINDOW_DAYS } from '../src/query/baseline.ts'

// The fourth browser-safe entry point, alongside ./metrics, ./coverage-signal and ./target-key
// (metrics-subpath.test.ts's own comment explains why apps/web cannot depend on the barrel at
// all). baseline.ts is not import-free the way metrics.ts is, and it is two hops rather than one:
// it imports shiftLocalDate from ../derive/localDay.ts and INSIGHT_MIN_DAY_FRACTION from
// ./insights.ts, and both of those import nothing at all, the same shape target-key-subpath.
// test.ts's own two-hop check takes for ConfigError/errors.ts. Added so apps/web's useBaseline
// could key a cached baseline read by the same from/to window /baselines itself reads (D9, the
// M3 phase review), rather than by the bare anchor date alone, which gave an override nothing to
// compare its own affected range against and left a stale baseline on screen after an exclusion.

const SUBPATH = './baseline-window'
const TARGET = './src/query/baseline.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

// Matches an `import` statement of any shape, and also an `export ... from '...'` re-export,
// the same blind spot target-key-subpath.test.ts's own copy of this pattern closes: a re-export
// pulls a module in exactly as surely as an import does but carries no `import` keyword at all.
const IMPORT_LINE = /^(?:import\s.*|export\s.*\bfrom\s*['"].*)$/gm

describe('the @haelan/core/baseline-window subpath', () => {
  it('is published, and points at the baseline module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
  })

  it('imports nothing from baseline.ts itself but localDay.ts and insights.ts', () => {
    // The entry point the subpath actually resolves to, not a file one hop further in. Vitest
    // runs under Node, where better-sqlite3 loads without complaint, so a stray import added
    // straight into baseline.ts (the file a future author would actually edit, to add a second
    // window shape or a new baseline field) would sail through every other test in this suite and
    // only break the bundle, silently. This is the one check standing between an edit here and
    // that failure mode.
    const baselineSource = read('../src/query/baseline.ts')
    const importLines = [...baselineSource.matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(importLines).toEqual([
      "import { shiftLocalDate } from '../derive/localDay.ts'",
      "import { INSIGHT_MIN_DAY_FRACTION } from './insights.ts'",
    ])
  })

  it('reaches localDay.ts through no import at all', () => {
    const localDaySource = read('../src/derive/localDay.ts')
    const importLines = [...localDaySource.matchAll(IMPORT_LINE)].map((m) => m[0])
    // Naive on purpose, the same way target-key-subpath.test.ts's own scan is: an empty list is
    // what "imports nothing at all" requires. A single import, of any shape, is exactly the drift
    // this test exists to catch before a bundle does, since localDay.ts is one of the two floors
    // this subpath's browser safety chain rests on.
    expect(importLines).toEqual([])
  })

  it('reaches insights.ts through no import at all', () => {
    const insightsSource = read('../src/query/insights.ts')
    const importLines = [...insightsSource.matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(importLines).toEqual([])
  })

  it('computes the same window /baselines itself reads through this subpath', () => {
    // Not a test of baselineWindow's own arithmetic, which packages/core/test/baseline.test.ts
    // already covers; this is the one check that the subpath resolves to a module that actually
    // behaves like the barrel's own baselineWindow, not a stale or renamed copy, the same role
    // target-key-subpath.test.ts's own round trip check plays for dayMetricTarget.
    expect(baselineWindow('2026-08-31')).toEqual({ from: '2026-07-02', to: '2026-08-30' })
    expect(BASELINE_WINDOW_DAYS).toBe(60)
  })
})
