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

  // Each interior bucket used to push both its min and its max unconditionally, so the output
  // was roughly twice the target rather than at it. Pinned at two targets so a regression back
  // to the doubled count cannot pass quietly.
  it('stays at or under target, not roughly double it', () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ x: i, y: i }))
    expect(thin(points, 10, { method: 'minmax', x: (p) => p.x, y: (p) => p.y }).points.length).toBeLessThanOrEqual(10)
    expect(thin(points, 50, { method: 'minmax', x: (p) => p.x, y: (p) => p.y }).points.length).toBeLessThanOrEqual(50)
  })

  // A naive sampler that ignores every y value and just spaces indices evenly passes the
  // keep-endpoints and stay-in-range properties, so only a spike positioned off that sampler's
  // grid can tell real LTTB from a values-blind stand-in. For 50 points at target 5, the grid a
  // reasonable evenly spaced sampler would land on is {0,12,24,25,30,36,37,49} across the
  // obvious formulas; index 45 is not one of them, so keeping it is evidence LTTB looked at y.
  it('keeps an off grid spike that an evenly spaced sampler would walk past', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i === 45 ? 999 : 1 }))
    const out = thin(points, 5, { method: 'lttb', x: (p) => p.x, y: (p) => p.y })
    expect(out.points.some((p) => p.y === 999)).toBe(true)
  })

  describe('edge cases', () => {
    it('never returns fewer than the smaller of two and the input length for a target of 0, 1 or 2', () => {
      const points = Array.from({ length: 10 }, (_, i) => ({ x: i, y: i }))
      for (const target of [0, 1, 2]) {
        for (const method of ['lttb', 'minmax'] as const) {
          const out = thin(points, target, { method, x: (p) => p.x, y: (p) => p.y })
          expect(out.points).toEqual([points[0], points.at(-1)])
        }
      }
    })

    it('returns a single point series untouched regardless of target', () => {
      const points = [{ x: 5, y: 5 }]
      for (const method of ['lttb', 'minmax'] as const) {
        const out = thin(points, 100, { method, x: (p) => p.x, y: (p) => p.y })
        expect(out.points).toEqual(points)
        expect(out.reduction).toBeNull()
      }
    })

    it('returns the input untouched when its length exactly equals the target', () => {
      const points = Array.from({ length: 20 }, (_, i) => ({ x: i, y: i }))
      for (const method of ['lttb', 'minmax'] as const) {
        const out = thin(points, 20, { method, x: (p) => p.x, y: (p) => p.y })
        expect(out.points).toEqual(points)
        expect(out.reduction).toBeNull()
      }
    })

    it('handles a series with no variation in y at all', () => {
      const points = Array.from({ length: 40 }, (_, i) => ({ x: i, y: 7 }))
      for (const method of ['lttb', 'minmax'] as const) {
        const out = thin(points, 10, { method, x: (p) => p.x, y: (p) => p.y })
        expect(out.points.length).toBeLessThanOrEqual(10)
        expect(out.points.every((p) => p.y === 7)).toBe(true)
        expect(out.points[0]).toEqual(points[0])
        expect(out.points.at(-1)).toEqual(points.at(-1))
      }
    })
  })
})
