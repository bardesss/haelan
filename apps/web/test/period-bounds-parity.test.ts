import { describe, expect, it } from 'vitest'
import { periodBounds, stepPeriod, PERIOD_RANGES } from '@haelan/core'
import { datesFor, stepAnchor } from '../src/controls/range.js'

// The server's period and the page's period must be the same days, or the page would print a
// verdict about a month it is not showing. Every anchor in two years, every range.
describe('core periodBounds matches the web datesFor', () => {
  const anchors: string[] = []
  for (let d = new Date('2027-01-01T00:00:00Z'); d < new Date('2029-01-01T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    anchors.push(d.toISOString().slice(0, 10))
  }
  for (const range of PERIOD_RANGES) {
    it(range, () => {
      for (const anchor of anchors) {
        expect(periodBounds(range, anchor)).toEqual(datesFor(range, anchor))
        expect(stepPeriod(range, anchor, -1)).toBe(stepAnchor(range, anchor, -1))
        expect(stepPeriod(range, anchor, 1)).toBe(stepAnchor(range, anchor, 1))
      }
    })
  }
})
