import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { thin } from '../src/query/downsample.ts'

const seriesArb = fc.array(fc.record({ x: fc.integer({ min: 0, max: 100_000 }), y: fc.integer({ min: -1000, max: 1000 }) }), { minLength: 1, maxLength: 500 })

// Both methods make the same three promises to a caller: stay in range, stay under budget, keep
// the endpoints. Fixing this to 'lttb' let minmax's budget break without any property catching it,
// so every property below is checked against both.
const methodArb = fc.constantFrom('lttb' as const, 'minmax' as const)

describe('thinning properties', () => {
  // A thinned series is a subset of the original points, so no y value it reports can fall
  // outside the range the original series actually held.
  it('never moves the series minimum or maximum outside the original range', () => {
    fc.assert(fc.property(seriesArb, fc.integer({ min: 2, max: 50 }), methodArb, (points, target, method) => {
      const out = thin(points, target, { method, x: (p) => p.x, y: (p) => p.y })
      const ys = points.map((p) => p.y)
      for (const p of out.points) {
        expect(p.y).toBeGreaterThanOrEqual(Math.min(...ys))
        expect(p.y).toBeLessThanOrEqual(Math.max(...ys))
      }
    }))
  })

  // The target is a budget, not a suggestion: a caller sizing a response for a token or pixel
  // budget needs the output to never exceed what it asked for (short series aside, which keep
  // at least their first and last point untouched).
  it('never returns more points than asked for', () => {
    fc.assert(fc.property(seriesArb, fc.integer({ min: 2, max: 50 }), methodArb, (points, target, method) => {
      expect(thin(points, target, { method, x: (p) => p.x, y: (p) => p.y }).points.length)
        .toBeLessThanOrEqual(Math.max(target, Math.min(points.length, 2)))
    }))
  })

  // Keeping the endpoints is what makes a thinned series still describe the same span of time as
  // the real one, rather than one that appears to start or end early.
  it('keeps the first and last point, so a thinned series still spans what the real one did', () => {
    fc.assert(fc.property(seriesArb, fc.integer({ min: 2, max: 50 }), methodArb, (points, target, method) => {
      const out = thin(points, target, { method, x: (p) => p.x, y: (p) => p.y })
      expect(out.points[0]).toEqual(points[0])
      expect(out.points.at(-1)).toEqual(points.at(-1))
    }))
  })
})
