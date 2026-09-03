import { describe, expect, it } from 'vitest'
import { METRICS } from '@haelan/core/metrics'
import { REQUESTS, INSIGHTS } from '../src/pages/Dashboard.js'

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

// INSIGHTS never passes through `under`'s own filter the way REQUESTS does (Dashboard.tsx's own
// comment on INSIGHTS states why: the three insight cards are curated literals, not derived from
// the catalogue), so nothing else here would catch a metric/agg pairing the catalogue stopped
// answering. /insights takes the same requireMetricAndAgg-shaped pairing /series does, so an
// unanswerable pairing here 400s the one card that asked for it, silently, the same defect this
// file already guards REQUESTS against.
describe("the Dashboard's insight cards", () => {
  const pairs = Object.values(INSIGHTS)

  it('name metrics the catalogue defines', () => {
    for (const { metric } of pairs) {
      expect(METRICS[metric], `${metric} is not a metric the catalogue defines`).toBeDefined()
    }
  })

  it('ask for aggs those metrics have rows under', () => {
    for (const { metric, agg } of pairs) {
      expect(METRICS[metric]?.aggs, `${metric} has no rows under '${agg}'`).toContain(agg)
    }
  })

  // States the shape the two tests above are quantified over, the same reason REQUESTS' own
  // "cover every group" test exists: three entries emptied by a bad edit would make both pass
  // vacuously otherwise.
  it('curates exactly three cards', () => {
    expect(pairs.length).toBe(3)
  })
})
