import { describe, expect, it } from 'vitest'
import { thin } from '../src/query/downsample.ts'

describe('thin', () => {
  it('returns the input untouched when it is already smaller than the target', () => {
    const points = [{ x: 1, y: 1 }, { x: 2, y: 2 }]
    const out = thin(points, 10, { method: 'lttb', x: (p) => p.x, y: (p) => p.y })
    expect(out.points).toEqual(points)
    expect(out.reduction).toBeNull()
  })

  // The reduction is not decoration. A client that was handed 400 points where 130,000 existed, and
  // cannot tell, has no way to state the basis of anything it draws.
  it('reports what it did when it did thin', () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: i }))
    const out = thin(points, 100, { method: 'lttb', x: (p) => p.x, y: (p) => p.y })
    expect(out.reduction).toEqual({ method: 'lttb', from: 1000, to: out.points.length })
  })

  // Min/max bucketing exists for anything drawn as a range. LTTB on a min/max band would discard
  // exactly the extremes the band is there to show, which is why the method is a per call choice
  // rather than one global default.
  it('keeps the extremes when bucketing a range', () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ x: i, y: i === 42 ? 999 : 1 }))
    const out = thin(points, 10, { method: 'minmax', x: (p) => p.x, y: (p) => p.y })
    expect(out.points.some((p) => p.y === 999)).toBe(true)
  })
})
