import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dataTypeForMetric } from '../src/api/metricDataType.ts'
import { DATA_TYPES } from '../src/api/catalogue.ts'

// The fifth browser-safe entry point, alongside ./metrics, ./coverage-signal, ./target-key and
// ./baseline-window (metrics-subpath.test.ts's own comment explains why apps/web cannot depend on
// the barrel at all). metricDataType.ts is not import-free the way metrics.ts is; it reads
// DATA_TYPES off catalogue.ts, the same one-hop shape coverage-signal-subpath.test.ts's own
// comment describes for coverageSignal.ts, and for the same reason: emptyState.ts needs to know
// which data type a metric belongs to, and only the catalogue can answer that without a
// hand-written second copy that a new type could silently fall out of sync with.

const SUBPATH = './metric-data-type'
const TARGET = './src/api/metricDataType.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

// Matches an `import` statement of any shape, and also an `export ... from '...'` re-export, the
// same blind spot every other subpath test in this file closes: a re-export pulls a module in
// exactly as surely as an import does but carries no `import` keyword at all.
const IMPORT_LINE = /^(?:import\s.*|export\s.*\bfrom\s*['"].*)$/gm

describe('the @haelan/core/metric-data-type subpath', () => {
  it('is published, and points at the metric data type module', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
    expect(pkg.exports[SUBPATH]).toBe(TARGET)
  })

  it('imports nothing from metricDataType.ts itself but the catalogue', () => {
    // The entry point the subpath actually resolves to, not a file one hop further in. Vitest
    // runs under Node, where better-sqlite3 loads without complaint, so a stray import added
    // straight into metricDataType.ts (the file a future author would actually edit) would sail
    // through every other test in this suite and only break the bundle, silently. This is the one
    // check standing between an edit here and that failure mode.
    const source = read('../src/api/metricDataType.ts')
    const importLines = [...source.matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(importLines).toEqual(["import { DATA_TYPES } from './catalogue.ts'"])
  })

  it('reaches catalogue.ts through nothing but an erased type import', () => {
    const catalogueSource = read('../src/api/catalogue.ts')
    const importLines = [...catalogueSource.matchAll(IMPORT_LINE)].map((m) => m[0])
    // Naive on purpose, the same way coverage-signal-subpath.test.ts's own scan is: one line
    // matching `import type { SampleAgg }` and nothing else is what "erased" requires. A second
    // import, of any shape, is exactly the drift this test exists to catch before a bundle does.
    expect(importLines).toEqual(["import type { SampleAgg } from '../db/schema/derived.ts'"])
  })

  it('maps every catalogue metric back to its type through this subpath', () => {
    // Not a test of dataTypeForMetric's own logic, which metric-data-type.test.ts already covers;
    // this is the one check that the subpath resolves to a module that actually behaves like the
    // direct import, not a stale or renamed copy, the same role target-key-subpath.test.ts's own
    // round trip check plays for dayMetricTarget.
    for (const type of DATA_TYPES) {
      if (type.metric !== '') expect(dataTypeForMetric(type.metric)).toBe(type.id)
    }
  })
})
