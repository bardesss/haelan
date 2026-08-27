import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { coverageIsMeaningful } from '../src/query/coverageSignal.ts'
import { DATA_TYPES } from '../src/api/catalogue.ts'

// The second browser-safe entry point, alongside ./metrics (metrics-subpath.test.ts carries that
// one's guarantee, and the comment there explains why apps/web cannot depend on the barrel at
// all). coverageSignal.ts is not import-free the way metrics.ts is: it reads DATA_TYPES off
// catalogue.ts, so the guarantee here is a step further out and checked differently. catalogue.ts
// itself imports exactly one thing, `import type { SampleAgg }`, and verbatimModuleSyntax
// (tsconfig.base.json) forbids that clause from ever carrying a value, so a bundler erases the
// statement rather than resolving it. Nothing past catalogue.ts, including the schema module that
// pulls in drizzle-orm, is reachable through this subpath as a result. Confirmed for real, not
// only argued: an apps/web production build importing this subpath carries no reference to
// better-sqlite3 or @node-rs/argon2 in its output bundle.

const SUBPATH = './coverage-signal'
const TARGET = './src/query/coverageSignal.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('the @haelan/core/coverage-signal subpath', () => {
  it('is published, and points at the coverage signal module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
  })

  it('imports nothing from coverageSignal.ts itself but the catalogue', () => {
    // The entry point the subpath actually resolves to, not a file one hop further in. Vitest
    // runs under Node, where better-sqlite3 loads without complaint, so a stray import added
    // straight into coverageSignal.ts (the file a future author would actually edit) would sail
    // through every other test in this suite and only break the bundle, silently. This is the
    // one check standing between an edit here and that failure mode.
    const signalSource = read('../src/query/coverageSignal.ts')
    const importLines = [...signalSource.matchAll(/^import\s.*$/gm)].map((m) => m[0])
    expect(importLines).toEqual(["import { DATA_TYPES } from '../api/catalogue.ts'"])
  })

  it('reaches catalogue.ts through nothing but an erased type import', () => {
    const catalogueSource = read('../src/api/catalogue.ts')
    const importLines = [...catalogueSource.matchAll(/^import\s.*$/gm)].map((m) => m[0])
    // Naive on purpose, the same way metrics-subpath.test.ts's comment-stripping scan is: one
    // line matching `import type { SampleAgg }` and nothing else is what "erased" requires. A
    // second import, of any shape, is exactly the drift this test exists to catch before a bundle
    // does.
    expect(importLines).toEqual(["import type { SampleAgg } from '../db/schema/derived.ts'"])
  })

  it('agrees with the intraday tier the catalogue actually declares', () => {
    // The fact this whole subpath exists to publish, checked against the catalogue directly
    // rather than against a second hand-written list: a metric this disagrees with is exactly
    // the drift apps/web/src/data/emptyState.ts used to be exposed to before it imported this.
    for (const type of DATA_TYPES) {
      expect(coverageIsMeaningful(type.metric), type.metric).toBe(type.tier === 'intraday')
    }
  })
})
