import { describe, it, expect } from 'vitest'
import { dayMetricTarget, sampleTarget, sessionTarget } from '@haelan/core/target-key'
import { overridesByMetric, annotationsFor } from '../src/data/chartAnnotations.js'
import type { StoredOverride } from '../src/data/useAnnotations.js'

/**
 * Direct coverage of `overridesByMetric`'s branches, none of which a page's own real render
 * reaches: `pages.test.tsx`'s `annotate wiring` block proves the wiring end to end with one
 * `exclude` row and no scope/parse edge cases, which is the shape a full page render can actually
 * stub. The cases below (a non `day_metric` scope, a malformed target key) are the ones a mutation
 * can delete without another test in this project noticing: this file exists so they cannot.
 */
function override(over: Partial<StoredOverride>): StoredOverride {
  return {
    id: 'o1', scope: 'day_metric', targetKey: dayMetricTarget({ localDate: '2026-08-11', metric: 'steps' }),
    action: 'exclude', correctedValue: null, reason: 'Watch left charging',
    ...over,
  }
}

describe('overridesByMetric', () => {
  it('puts an exclude row in `excluded`, with its reason in `annotations`', () => {
    const map = overridesByMetric([override({ action: 'exclude', reason: 'Left it charging' })])
    const entry = annotationsFor(map, 'steps')
    expect(entry.excluded).toEqual(['2026-08-11'])
    expect(entry.annotations).toEqual([{ date: '2026-08-11', text: 'Left it charging' }])
  })

  // A day scoped correction cannot be written at all: `POST /overrides` is the only writer of an
  // override row and OverrideStore.validate refuses `correct` at every scope but `sample`. This
  // file used to pin a rendering for one, which certified a response the server refuses to send.
  // What is pinned now is the guard that would matter if such a row ever appeared: nothing but an
  // `exclude` marks a day as thrown out, so a correction can never reach a chart as an exclusion,
  // which is the one way this could tell a reader something false. The reason a person wrote is
  // still theirs, so it still reaches `annotations`.
  it('never marks a day excluded for an action that is not exclude, but keeps its reason', () => {
    const map = overridesByMetric([override({
      action: 'correct', correctedValue: 58, reason: 'Chest strap read low',
    })])
    const entry = annotationsFor(map, 'steps')
    expect(entry.excluded).toEqual([])
    expect(entry.annotations).toEqual([{ date: '2026-08-11', text: 'Chest strap read low' }])
  })

  // `sample` and `session` scoped rows: this milestone's panel never writes either (AnnotatePanel.tsx
  // builds every target with `dayMetricTarget` alone), but the /overrides list this reads is not
  // scoped to what one panel writes, and a `sample`/`session` row names no metric a by-day chart
  // could place a mark against.
  //
  // Both cases below give the mismatched row a `targetKey` that parses as a valid day_metric shape
  // anyway (rather than each scope's own real shape, `sampleTarget`/`sessionTarget`), on purpose:
  // a `sample` or `session` row's own real target key never parses as day_metric
  // (`parseDayMetricTarget` requires `localDate` and `metric`, neither of which a sample or session
  // target carries), so a version of this function missing the `scope !== 'day_metric'` guard
  // entirely would still pass a test built from `sampleTarget`/`sessionTarget` - the parse failure
  // alone would explain the row being skipped, and the scope guard could vanish unnoticed. Giving
  // the row a day_metric shaped key it has no business carrying isolates the guard this function
  // actually needs to have: scope decides the row's fate here, not merely whether the key parses.
  it('ignores a sample scoped row even when its target key happens to parse as day_metric shaped', () => {
    const map = overridesByMetric([override({ scope: 'sample', targetKey: dayMetricTarget({ localDate: '2026-08-11', metric: 'steps' }) })])
    expect(annotationsFor(map, 'steps')).toEqual({ excluded: [], annotations: [] })
  })

  it('ignores a session scoped row the same way', () => {
    const map = overridesByMetric([override({ scope: 'session', targetKey: dayMetricTarget({ localDate: '2026-08-11', metric: 'steps' }) })])
    expect(annotationsFor(map, 'steps')).toEqual({ excluded: [], annotations: [] })
  })

  // The real shapes too, for completeness (a sample/session row as the store would actually write
  // it), even though the pair above is what actually pins the scope guard's own necessity.
  it('ignores a sample scoped row carrying its own real sample-shaped target key', () => {
    const map = overridesByMetric([
      override({ scope: 'sample', targetKey: sampleTarget({ source: 'watch', metric: 'steps', utcMs: 0 }) }),
    ])
    expect(annotationsFor(map, 'steps')).toEqual({ excluded: [], annotations: [] })
  })

  it('ignores a session scoped row carrying its own real session-shaped target key', () => {
    const map = overridesByMetric([override({ scope: 'session', targetKey: sessionTarget('sess-1') })])
    expect(annotationsFor(map, 'steps')).toEqual({ excluded: [], annotations: [] })
  })

  // The crash guard: parseDayMetricTarget throws on a target_key this build cannot parse (not
  // valid JSON, or valid JSON missing localDate/metric), which is exactly what a row written by a
  // schema ahead of this one, or hand corrupted data, would look like. One bad row must not take a
  // whole page's overrides read down with it; the try/catch is what stops that, and a mutation that
  // replaced it with a bare call would throw synchronously inside the loop below, failing this test
  // (and every page's own render) rather than skipping the one row that cannot be understood.
  it('skips a row whose target key is not parseable JSON, without throwing, and keeps the good rows beside it', () => {
    const good = override({ targetKey: dayMetricTarget({ localDate: '2026-08-12', metric: 'steps' }) })
    const bad = override({ id: 'o2', targetKey: 'not json at all' })
    expect(() => overridesByMetric([good, bad])).not.toThrow()
    const entry = annotationsFor(overridesByMetric([good, bad]), 'steps')
    expect(entry.excluded).toEqual(['2026-08-12'])
  })

  it('skips a row whose target key is valid JSON but not a day_metric shape, without throwing', () => {
    const good = override({ targetKey: dayMetricTarget({ localDate: '2026-08-13', metric: 'steps' }) })
    const bad = override({ id: 'o3', targetKey: JSON.stringify({ nothing: 'useful' }) })
    expect(() => overridesByMetric([good, bad])).not.toThrow()
    const entry = annotationsFor(overridesByMetric([good, bad]), 'steps')
    expect(entry.excluded).toEqual(['2026-08-13'])
  })
})

describe('annotationsFor', () => {
  it('returns the same frozen empty pair, by identity, for every metric no override touches', () => {
    // Chart props are keyed on this identity: a fresh {excluded:[],...} literal per call would
    // hand useChart's build callback a new identity every render and dispose the chart
    // (chart-lifecycle.test.tsx guards the render side of this; this pins the source of the value).
    const map = overridesByMetric([])
    expect(annotationsFor(map, 'steps')).toBe(annotationsFor(map, 'heart_rate'))
  })
})
