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

  // Spec section 9's third named property for the downsampler, alongside the two above: a
  // min/max-bucketed range always contains every input point. minmax exists so a range band never
  // loses the true extreme it was drawn to show, so the point holding the series' overall minimum
  // and the point holding its overall maximum must both come back, wherever in the series they
  // fell. lttb makes no such promise, since it optimises for a line's shape rather than a band's
  // edges, so this property is checked against minmax alone.
  //
  // target starts at 4 rather than 2: a target of 2 or 3 falls into the edge case documented in
  // `query-downsample.test.ts`, where thin keeps only the first and last point regardless of
  // value and is not making the min/max promise at all. Once target reaches 4 there is at least
  // one interior bucket, which is the smallest case where the promise applies.
  it('keeps the series minimum and maximum in a min/max-bucketed range', () => {
    fc.assert(fc.property(seriesArb, fc.integer({ min: 4, max: 50 }), (points, target) => {
      const out = thin(points, target, { method: 'minmax', x: (p) => p.x, y: (p) => p.y })
      const ys = points.map((p) => p.y)
      const outYs = out.points.map((p) => p.y)
      expect(Math.min(...outYs)).toBe(Math.min(...ys))
      expect(Math.max(...outYs)).toBe(Math.max(...ys))
    }))
  })
})
