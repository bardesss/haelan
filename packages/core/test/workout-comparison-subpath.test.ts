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

  it('imports nothing but workoutSummary, which is itself import-free', () => {
    const importLines = [...read('../src/api/workoutComparison.ts').matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(importLines).toEqual(["import { workoutSummary } from './workoutSummary.ts'"])
    const summaryImports = [...read('../src/api/workoutSummary.ts').matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(summaryImports).toEqual([])
  })

  it('is a pure function of its arguments', () => {
    const subject = { id: 'a', startMs: 1000, excluded: false, attrs: {} }
    expect(compareWorkout(subject, [])).toEqual(compareWorkout(subject, []))
  })
})
