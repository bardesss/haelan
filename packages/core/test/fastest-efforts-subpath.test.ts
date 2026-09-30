import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EFFORT_DISTANCES_BY_CATEGORY, fastestEfforts } from '../src/api/fastestEfforts.ts'

// The browser-safe entry point the Records page reads EFFORT_DISTANCES_BY_CATEGORY through (M10b PR 6).
// apps/web cannot depend on the barrel (it pulls better-sqlite3 and drizzle into a browser bundle).
// Unlike workout-comparison, this module reaches into query/, where nearly every module imports
// the database: it borrows haversineMeters from workoutThrough.ts, which today imports nothing.
// An import added there would break the web bundle while every Node test stayed green; this is the
// test that goes red instead.
const SUBPATH = './fastest-efforts'
const TARGET = './src/api/fastestEfforts.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const IMPORT_LINE = /^(?:import\s.*|export\s.*\bfrom\s*['"].*)$/gm

describe('the @haelan/core/fastest-efforts subpath', () => {
  it('is published, and points at the efforts module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
  })

  // The property, as workout-comparison-subpath.test.ts holds it: everything the module reaches is
  // itself import-free, so the graph stops one level down. A relative module of src/ only.
  it('reaches only modules that are themselves import-free', () => {
    const source = read('../src/api/fastestEfforts.ts')
    const imports = [...source.matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(imports.length, 'the module should still import something').toBeGreaterThan(0)

    for (const line of imports) {
      const from = /['"](.+)['"]/.exec(line)?.[1]
      expect(from, `could not read a path out of: ${line}`).toBeDefined()
      expect(from, 'a relative module inside src/, never a package')
        .toMatch(/^(?:\.\/|\.\.\/[a-z]+\/)[A-Za-z]+\.ts$/)
      const target = new URL(from!, new URL('../src/api/', import.meta.url))
      // A type-only import is erased before any bundle sees it (workoutThrough.ts names
      // ExerciseCategory as a type), so it reaches nothing; any import that survives does.
      const reached = [...readFileSync(fileURLToPath(target), 'utf8').matchAll(IMPORT_LINE)]
        .map((m) => m[0]).filter((l) => !/^import\s+type\s/.test(l))
      expect(reached, `${from} must import nothing`).toEqual([])
    }
  })

  it('is a pure function of its arguments', () => {
    expect(Object.keys(EFFORT_DISTANCES_BY_CATEGORY)).toEqual(['run', 'ride'])
    expect(fastestEfforts([], 'run')).toEqual(fastestEfforts([], 'run'))
  })
})
