import { describe, it, expect } from 'vitest'
import type { UseQueryResult } from '@tanstack/react-query'
import { compactRecorded, compactSeries } from '../../demo/capture/compact.ts'
import { distinctSources } from '../../apps/web/src/data/pageShell.ts'
import type { MetricSeries } from '../../apps/web/src/data/useSeries.ts'

const mixA = '[{"source":"a","hours":24}]'
const mixAB = '[{"source":"a","hours":12},{"source":"b","hours":12}]'

function point(localDate: string, sourceMix: string | null, extra: Record<string, unknown> = {}) {
  return { localDate, value: 1, coverage: 0.9, source: 'merged', sourceMix, updatedAtMs: 1790690991025, filled: false, ...extra }
}

function body() {
  return {
    steps: {
      points: [point('2026-01-01', mixA), point('2026-01-02', mixA), point('2026-01-03', mixAB), point('2026-01-04', mixA), point('2026-01-05', mixA, { filled: true })],
      reduction: null,
    },
    floors: { points: [point('2026-01-01', null)], reduction: null },
  }
}

const sourcesOf = (data: unknown) => distinctSources([{ data } as UseQueryResult<Record<string, MetricSeries>>])

describe('compactSeries', () => {
  it('drops updatedAtMs and source, and keeps what the pages read', () => {
    const compacted = compactSeries(body())
    for (const series of Object.values(compacted)) {
      for (const p of series.points) {
        expect(p).not.toHaveProperty('updatedAtMs')
        expect(p).not.toHaveProperty('source')
      }
    }
    expect(compacted.steps!.points.map((p) => [(p as { localDate: string }).localDate, (p as { filled: boolean }).filled]))
      .toEqual([['2026-01-01', false], ['2026-01-02', false], ['2026-01-03', false], ['2026-01-04', false], ['2026-01-05', true]])
    expect(compacted.steps!.points.every((p) => (p as { coverage: number }).coverage === 0.9)).toBe(true)
    expect(compacted.floors!.points[0]!.sourceMix).toBeNull()
  })

  it('keeps each mix on its first and last point only, and the source picker offers the same sources', () => {
    const original = body()
    const compacted = compactSeries(original)
    expect(compacted.steps!.points.map((p) => p.sourceMix)).toEqual([mixA, undefined, mixAB, undefined, mixA])
    expect(sourcesOf(compacted)).toEqual(sourcesOf(original))
    expect(sourcesOf(compacted)).toEqual(['a', 'b'])
  })

  it('still offers every source once a visitor excludes the first day', () => {
    const compacted = compactSeries(body())
    compacted.steps!.points = compacted.steps!.points.slice(1)
    expect(sourcesOf(compacted)).toEqual(['a', 'b'])
  })

  it('leaves the captured body untouched', () => {
    const original = body()
    compactSeries(original)
    expect(original).toEqual(body())
  })
})

describe('compactRecorded', () => {
  it('rewrites /series responses only', () => {
    const glance = { strip: [{ localDate: '2026-01-01', source: 'merged', updatedAtMs: 1 }] }
    const recorded = new Map<string, unknown>([
      ['/api/v1/p/demo/series?agg=sum&metric=steps', body()],
      ['/api/v1/p/demo/glance', glance],
    ])
    compactRecorded(recorded)
    const steps = (recorded.get('/api/v1/p/demo/series?agg=sum&metric=steps') as ReturnType<typeof body>).steps
    expect(steps.points[0]).not.toHaveProperty('updatedAtMs')
    expect(recorded.get('/api/v1/p/demo/glance')).toEqual({ strip: [{ localDate: '2026-01-01', source: 'merged', updatedAtMs: 1 }] })
  })
})
