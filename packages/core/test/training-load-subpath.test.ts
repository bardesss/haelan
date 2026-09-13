import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHRONIC_DAYS, chronicWindowStart, trainingLoad } from '../src/api/trainingLoad.ts'

// The tenth browser-safe entry point (metrics-subpath.test.ts's own comment explains why apps/web
// cannot depend on the barrel at all). trainingLoad.ts is not import-free the way metrics.ts is:
// it imports shiftLocalDate from ../derive/localDay.ts, which imports nothing, the same one-hop
// shape baseline-window-subpath.test.ts checks for baseline.ts.

const SUBPATH = './training-load'
const TARGET = './src/api/trainingLoad.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

// Matches an `import` statement of any shape, and also an `export ... from '...'` re-export: a
// re-export pulls a module in exactly as surely as an import does but carries no `import` keyword.
const IMPORT_LINE = /^(?:import\s.*|export\s.*\bfrom\s*['"].*)$/gm

describe('the @haelan/core/training-load subpath', () => {
  it('is published, and points at the training load module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
  })

  it('imports nothing from trainingLoad.ts itself but localDay.ts', () => {
    // The entry point the subpath actually resolves to. Vitest runs under Node, where
    // better-sqlite3 loads without complaint, so a stray import added straight into
    // trainingLoad.ts would sail through every other test in this suite and only break the bundle.
    const source = read('../src/api/trainingLoad.ts')
    const importLines = [...source.matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(importLines).toEqual([
      "import { shiftLocalDate } from '../derive/localDay.ts'",
    ])
  })

  it('reaches localDay.ts through no import at all', () => {
    const localDaySource = read('../src/derive/localDay.ts')
    const importLines = [...localDaySource.matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(importLines).toEqual([])
  })

  it('computes through this subpath the window the card actually fetches', () => {
    // Not a test of the arithmetic, which training-load.test.ts covers; this is the check that the
    // subpath resolves to a module that behaves like the real one rather than a stale copy. The
    // window helper matters most here: apps/web fetches the span it returns, so a drift between
    // this and trainingLoad's own reading would silently change which days the floors judge.
    expect(chronicWindowStart('2026-09-13')).toBe('2026-08-17')
    expect(CHRONIC_DAYS).toBe(28)
    expect(trainingLoad([], '2026-09-13').enough).toBe(false)
  })
})
