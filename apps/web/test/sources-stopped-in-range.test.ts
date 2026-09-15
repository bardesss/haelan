import { describe, it, expect } from 'vitest'
import type { UseQueryResult } from '@tanstack/react-query'
import { sourcesStoppedInRange } from '../src/data/pageShell.js'
import type { MetricSeries } from '../src/data/useSeries.js'

/** One day's merged point, contributed by `sources`. */
const point = (localDate: string, sources: string[]) => ({
  localDate, value: 1000, coverage: 0.9,
  sourceMix: JSON.stringify(sources.map((source) => ({ source, hours: 1 }))),
})

const query = (points: ReturnType<typeof point>[]) =>
  ({ data: { steps: { points } } } as unknown as UseQueryResult<Record<string, MetricSeries>>)

/** `days` consecutive dates from `from`. */
const run = (from: string, days: number): string[] => {
  const start = Date.parse(`${from}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10))
}

describe('sourcesStoppedInRange', () => {
  it('names a source that fed the range and then went quiet inside it', () => {
    // 20 days in, then nothing for the remaining 20 of a 40 day range.
    const points = run('2026-01-01', 20).map((d) => point(d, ['watch']))
    expect(sourcesStoppedInRange([query(points)], '2026-02-09')).toEqual(['watch'])
  })

  it('says nothing about a source still reporting at the end of the range', () => {
    const points = run('2026-01-01', 40).map((d) => point(d, ['watch']))
    expect(sourcesStoppedInRange([query(points)], '2026-02-09')).toEqual([])
  })

  it('says nothing when the range is too short to have shown a cadence', () => {
    // Seven days of data and a week-long range: nothing here supports the claim that a source
    // stopped, and inventing one would put a warning on every chart at the shortest range.
    const points = run('2026-01-01', 7).map((d) => point(d, ['watch']))
    expect(sourcesStoppedInRange([query(points)], '2026-01-31')).toEqual([])
  })

  it('names only the one that stopped when another kept going', () => {
    const points = [
      ...run('2026-01-01', 20).map((d) => point(d, ['watch', 'phone'])),
      ...run('2026-01-21', 20).map((d) => point(d, ['phone'])),
    ]
    expect(sourcesStoppedInRange([query(points)], '2026-02-09')).toEqual(['watch'])
  })

  it('counts a day once when several metrics report it', () => {
    // Two metrics over the same 13 days is 26 points and 13 dates. Counted as 26 the source
    // would clear the history gate it should not clear.
    const days = run('2026-01-01', 13).map((d) => point(d, ['watch']))
    const two = { data: { steps: { points: days }, distance: { points: days } } } as unknown as
      UseQueryResult<Record<string, MetricSeries>>
    expect(sourcesStoppedInRange([two], '2026-03-01')).toEqual([])
  })

  it('answers nothing for a query that has not resolved', () => {
    const pending = { data: undefined } as unknown as UseQueryResult<Record<string, MetricSeries>>
    expect(sourcesStoppedInRange([pending], '2026-02-09')).toEqual([])
  })
})
