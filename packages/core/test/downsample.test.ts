import { describe, expect, it } from 'vitest'
import { downsampleToMinute } from '../src/api/downsample.ts'
import type { SampleRow } from '../src/api/mapSamples.ts'

const at = (seconds: number, value: number): SampleRow => ({
  personId: 'p1', sourceId: 's1', metric: 'heart_rate',
  utcMs: Date.UTC(2026, 7, 18, 10, 0, 0) + seconds * 1000,
  tzOffsetMinutes: 120, agg: 'mean', value, n: 1, rawPayloadId: 'r1',
})

describe('downsampleToMinute', () => {
  it('turns a minute of readings into min, mean and max', () => {
    const out = downsampleToMinute([at(0, 60), at(2, 70), at(4, 65)])
    expect(out).toHaveLength(3)
    const byAgg = Object.fromEntries(out.map((r) => [r.agg, r.value]))
    expect(byAgg['min']).toBe(60)
    expect(byAgg['max']).toBe(70)
    expect(byAgg['mean']).toBeCloseTo(65, 10)
  })

  it('anchors every row to the start of its minute, so the natural key collides on purpose', () => {
    const out = downsampleToMinute([at(0, 60), at(59, 61)])
    expect(new Set(out.map((r) => r.utcMs))).toEqual(new Set([Date.UTC(2026, 7, 18, 10, 0, 0)]))
  })

  it('records how many readings each aggregate came from', () => {
    const out = downsampleToMinute([at(0, 60), at(2, 70), at(4, 65)])
    expect(out.every((r) => r.n === 3)).toBe(true)
  })

  it('keeps separate minutes separate', () => {
    const out = downsampleToMinute([at(0, 60), at(60, 80)])
    expect(new Set(out.map((r) => r.utcMs)).size).toBe(2)
    expect(out).toHaveLength(6)
  })

  it('keeps separate sources separate, because merging never happens on write', () => {
    const other = { ...at(0, 200), sourceId: 's2' }
    const out = downsampleToMinute([at(0, 60), other])
    expect(out.filter((r) => r.sourceId === 's1')).toHaveLength(3)
    expect(out.filter((r) => r.sourceId === 's2')).toHaveLength(3)
  })

  it('carries the offset of the first reading in the minute', () => {
    expect(downsampleToMinute([at(0, 60)])[0]?.tzOffsetMinutes).toBe(120)
  })

  it('is a thirty fold reduction on a real minute of 2 second sampling', () => {
    const minute = Array.from({ length: 30 }, (_, i) => at(i * 2, 60 + i))
    expect(downsampleToMinute(minute)).toHaveLength(3)
  })

  it('returns nothing for nothing', () => {
    expect(downsampleToMinute([])).toEqual([])
  })
})
