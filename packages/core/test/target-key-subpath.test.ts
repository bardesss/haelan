import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dayMetricTarget, parseDayMetricTarget } from '../src/derive/targetKey.ts'

// The third browser-safe entry point, alongside ./metrics and ./coverage-signal
// (coverage-signal-subpath.test.ts carries that one's guarantee and its comment explains why
// apps/web cannot depend on the barrel at all). targetKey.ts imports exactly one thing,
// ConfigError from ../errors.ts, and errors.ts imports nothing at all, so the chain here is one
// hop shorter than coverage-signal's own two hop reach through catalogue.ts.

const SUBPATH = './target-key'
const TARGET = './src/derive/targetKey.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('the @haelan/core/target-key subpath', () => {
  it('is published, and points at the target key module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
  })

  it('imports nothing from targetKey.ts itself but ConfigError', () => {
    // The entry point the subpath actually resolves to, not a file one hop further in. Vitest
    // runs under Node, where better-sqlite3 loads without complaint, so a stray import added
    // straight into targetKey.ts (the file a future author would actually edit) would sail
    // through every other test in this suite and only break the bundle, silently. This is the
    // one check standing between an edit here and that failure mode.
    const targetKeySource = read('../src/derive/targetKey.ts')
    const importLines = [...targetKeySource.matchAll(/^import\s.*$/gm)].map((m) => m[0])
    expect(importLines).toEqual(["import { ConfigError } from '../errors.ts'"])
  })

  it('reaches errors.ts through no import at all', () => {
    const errorsSource = read('../src/errors.ts')
    const importLines = [...errorsSource.matchAll(/^import\s.*$/gm)].map((m) => m[0])
    // Naive on purpose, the same way coverage-signal-subpath.test.ts's own scan is: an empty
    // list is what "imports nothing at all" requires. A single import, of any shape, is exactly
    // the drift this test exists to catch before a bundle does, since errors.ts is the floor
    // this subpath's browser safety chain rests on.
    expect(importLines).toEqual([])
  })

  it('round trips a day metric target the way the barrel export would', () => {
    // Not a test of targetKey.ts's own logic, which packages/core/test/target-key.test.ts already
    // covers; this is the one check that the subpath resolves to a module that actually behaves
    // like the barrel's dayMetricTarget/parseDayMetricTarget pair, not a stale or renamed copy.
    const key = dayMetricTarget({ localDate: '2026-08-15', metric: 'steps' })
    expect(parseDayMetricTarget(key)).toEqual({ localDate: '2026-08-15', metric: 'steps' })
  })
})
