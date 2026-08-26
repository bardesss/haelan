import { describe, expect, it } from 'vitest'
import { METRICS } from '@haelan/core/metrics'
import { REQUESTS } from '../src/pages/Dashboard.js'

// The Dashboard picks which agg each of its cards shows, and /series takes one agg for a whole
// call and rejects the call outright if any metric in it has no rows under that agg. So a pairing
// the catalogue cannot answer is not one blank card, it is every card in that group plus a 500:
// three of them ride the 'last' request together. Nothing in the type system catches it either,
// because METRICS is keyed by plain string and 'stepss' is a perfectly good string.
//
// This is where it is caught instead, and it is the reason the page reads @haelan/core/metrics
// rather than restating it. Before the package had a browser safe entry point the pairing was a
// hand-written table justified in a comment, and a comment cannot go red when the catalogue moves
// underneath it.
//
// A node environment file on purpose: this asserts an exported constant, so it needs no DOM and
// none of the mounting machinery dashboard-cards.test.tsx carries.
describe("the Dashboard's requested metrics", () => {
  const pairs = Object.entries(REQUESTS)
    .flatMap(([agg, metrics]) => metrics.map((metric) => [metric, agg] as const))

  it('name metrics the catalogue defines', () => {
    for (const [metric] of pairs) {
      expect(METRICS[metric], `${metric} is not a metric the catalogue defines`).toBeDefined()
    }
  })

  it('ask for aggs those metrics have rows under', () => {
    for (const [metric, agg] of pairs) {
      expect(METRICS[metric]?.aggs, `${metric} has no rows under '${agg}'`).toContain(agg)
    }
  })

  // Guards the filter in `under` rather than the table: if a pairing above ever stops being
  // answerable, the page silently drops it and the card goes blank, and the two tests above are
  // what fire. This one states the shape those two are quantified over, so a group emptied by a
  // bad merge cannot make them vacuously pass.
  it('cover every group the page requests', () => {
    expect(Object.keys(REQUESTS).sort()).toEqual(['last', 'max', 'mean', 'min', 'sum'])
    expect(pairs.length).toBe(8)
  })
})
