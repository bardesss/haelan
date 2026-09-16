import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compareWorkout } from '../src/api/workoutComparison.ts'

// The seventh browser-safe entry point. apps/web cannot depend on the barrel at all (it pulls
// better-sqlite3 and drizzle into a browser bundle), which is why this module lives in api/ beside
// workoutSummary.ts rather than in query/ where a ranking might otherwise belong: every module in
// query/ imports the database.
const SUBPATH = './workout-comparison'
const TARGET = './src/api/workoutComparison.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const IMPORT_LINE = /^(?:import\s.*|export\s.*\bfrom\s*['"].*)$/gm

describe('the @haelan/core/workout-comparison subpath', () => {
  it('is published, and points at the comparison module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
  })

  /*
   * The property, rather than a list of the imports that happened to exist when this was written.
   *
   * What keeps this subpath safe in a browser bundle is that everything it reaches is itself
   * import-free, so the graph stops one level down and can never pull better-sqlite3 in behind it.
   * Pinning the exact import line asserted that property by proxy and had to be edited every time
   * a legitimate sibling was added - which is the edit most likely to be made by loosening it to
   * `toContain`. This walks the imports instead and holds each one to the same standard, so adding
   * a sibling that is NOT import-free still fails, and adding one that is does not.
   */
  it('reaches only modules that are themselves import-free', () => {
    const source = read('../src/api/workoutComparison.ts')
    const imports = [...source.matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(imports.length, 'the module should still import something').toBeGreaterThan(0)

    for (const line of imports) {
      const from = /['"](.+)['"]/.exec(line)?.[1]
      expect(from, `could not read a path out of: ${line}`).toBeDefined()
      expect(from, 'a relative sibling in api/, never a package or a deeper directory')
        .toMatch(/^\.\/[A-Za-z]+\.ts$/)
      const siblingImports = [...read(`../src/api/${from!.slice(2)}`).matchAll(IMPORT_LINE)]
      expect(siblingImports.map((m) => m[0]), `${from} must import nothing`).toEqual([])
    }
  })

  it('is a pure function of its arguments', () => {
    const subject = { id: 'a', startMs: 1000, excluded: false, attrs: {} }
    expect(compareWorkout(subject, [])).toEqual(compareWorkout(subject, []))
  })
})
