import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dataTypeForMetric } from '../src/api/metricDataType.ts'
import { DATA_TYPES } from '../src/api/catalogue.ts'

// The fifth browser-safe entry point, alongside ./metrics, ./coverage-signal, ./target-key and
// ./baseline-window (metrics-subpath.test.ts's own comment explains why apps/web cannot depend on
// the barrel at all). metricDataType.ts is not import-free the way metrics.ts is; it reads
// DATA_TYPES off catalogue.ts, the same one-hop shape coverage-signal-subpath.test.ts's own
// comment describes for coverageSignal.ts, for the same reason: emptyState.ts needs to know which
// data type a metric belongs to, and the catalogue answers that for every metric but two. It also
// reads SLEEP_METRICS off derive/metrics.ts, which metrics-subpath.test.ts already established is
// import-free, for the sleep and exercise families the catalogue cannot answer for at all (see
// metricDataType.ts's own comment on why that pair is named by hand). Two safe hops rather than
// one, but both still nowhere near better-sqlite3 or @node-rs/argon2.

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

  it('imports nothing from metricDataType.ts itself but the catalogue and derive/metrics', () => {
    // The entry point the subpath actually resolves to, not a file one hop further in. Vitest
    // runs under Node, where better-sqlite3 loads without complaint, so a stray import added
    // straight into metricDataType.ts (the file a future author would actually edit) would sail
    // through every other test in this suite and only break the bundle, silently. This is the one
    // check standing between an edit here and that failure mode.
    const source = read('../src/api/metricDataType.ts')
    const importLines = [...source.matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(importLines).toEqual([
      "import { DATA_TYPES } from './catalogue.ts'",
      "import { SLEEP_METRICS } from '../derive/metrics.ts'",
    ])
  })

  it('reaches catalogue.ts through nothing but an erased type import', () => {
    const catalogueSource = read('../src/api/catalogue.ts')
    const importLines = [...catalogueSource.matchAll(IMPORT_LINE)].map((m) => m[0])
    // Naive on purpose, the same way coverage-signal-subpath.test.ts's own scan is: one line
    // matching `import type { SampleAgg }` and nothing else is what "erased" requires. A second
    // import, of any shape, is exactly the drift this test exists to catch before a bundle does.
    expect(importLines).toEqual(["import type { SampleAgg } from '../db/schema/derived.ts'"])
  })

  it('reaches derive/metrics.ts through no import at all', () => {
    // The other hop this subpath now takes. metrics-subpath.test.ts already holds this file to
    // "imports nothing" with a comment-stripping scan of its own; this re-checks the same fact
    // with the plain line scan every other assertion in this file uses, so a second import added
    // here shows up the same way a second import into catalogue.ts above would.
    const metricsSource = read('../src/derive/metrics.ts')
    const importLines = [...metricsSource.matchAll(IMPORT_LINE)].map((m) => m[0])
    expect(importLines).toEqual([])
  })

  it('agrees with the catalogue on every metric the catalogue itself declares', () => {
    // Deliberately the same check metric-data-type.test.ts's own "covers every metric every
    // catalogue entry declares" runs, imported from the same file: this is not a test of the
    // subpath resolving to a *different*, comparable module (unlike target-key-subpath.test.ts's
    // own round trip against the barrel's dayMetricTarget, there is no second entry point that
    // also publishes dataTypeForMetric to compare against). What it pins is this subpath's own
    // contract, the same way coverage-signal-subpath.test.ts's closing test pins coverageSignal's:
    // read against the catalogue directly rather than a second hand-written list, so it cannot
    // silently drift the day a type is added. It does not reach the sleep or exercise families
    // metric-data-type.test.ts covers, since neither carries a `type.metric` this loop reads.
    for (const type of DATA_TYPES) {
      if (type.metric !== '') expect(dataTypeForMetric(type.metric)).toBe(type.id)
    }
  })
})
