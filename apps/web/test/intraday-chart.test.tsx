import { describe, expect, it } from 'vitest'
import { intradayBasis, seriesBySource } from '../src/charts/IntradayHeartRate.js'
import type { IntradayPoint } from '../src/data/useIntraday.js'
import type { Translate } from '../src/format.js'

const at = (utcMs: number, sourceId: string, mean: number): IntradayPoint =>
  ({ sourceId, utcMs, min: mean - 5, mean, max: mean + 5 })

describe('seriesBySource', () => {
  // readIntraday pivots on source and minute together, because two devices can report the same
  // minute. A day with two devices must draw two lines: averaging them would invent a reading
  // neither device reported, and picking one would silently drop the other.
  it('splits a two source day into one series per source, keeping every point', () => {
    const points = [
      at(0, 'watch', 60), at(60000, 'watch', 62),
      at(0, 'phone', 70), at(60000, 'phone', 71),
    ]
    const series = seriesBySource(points)
    expect(series).toHaveLength(2)
    expect(series.flatMap((s) => s.points)).toHaveLength(4)
    const watch = series.find((s) => s.sourceId === 'watch')
    expect(watch?.points.map((p) => p.mean)).toEqual([60, 62])
  })

  // The single source case goes through the same code rather than a shortcut, so the two cases
  // cannot diverge.
  it('gives a one source day one series rather than a bare list', () => {
    const series = seriesBySource([at(0, 'watch', 60), at(60000, 'watch', 62)])
    expect(series).toHaveLength(1)
    expect(series[0]!.sourceId).toBe('watch')
  })

  // Points arrive ordered by minute per source, but the two sources interleave in the response.
  // A series whose points are out of order draws a line that doubles back on itself.
  it('keeps each series ordered by time when the sources interleave', () => {
    const points = [
      at(0, 'watch', 60), at(0, 'phone', 70),
      at(120000, 'watch', 64), at(60000, 'phone', 71), at(60000, 'watch', 62),
    ]
    const watch = seriesBySource(points).find((s) => s.sourceId === 'watch')!
    expect(watch.points.map((p) => p.utcMs)).toEqual([0, 60000, 120000])
  })

  it('answers an empty list for a day with no points, rather than one empty series', () => {
    expect(seriesBySource([])).toEqual([])
  })
})

// A stub, not a real i18n instance, the same device format.test.ts's own stubT uses for trend():
// intradayBasis only needs something call-shaped like `t`, and pinning one language's prose here
// would test a translator's wording rather than what intradayBasis itself decided to ask for.
function stubT(): { t: Translate, calls: [string, Record<string, unknown> | undefined][] } {
  const calls: [string, Record<string, unknown> | undefined][] = []
  const t: Translate = (key, options) => {
    calls.push([key, options])
    return `t(${key})`
  }
  return { t, calls }
}

describe('intradayBasis', () => {
  // downsample.ts's own comment: reduction is null "so a client can tell 400 points that are the
  // whole series from 400 points standing in for 130,000". An object here is the other half of
  // that distinction: these points stand in for more than what is drawn, and the card has to say
  // how many samples were thinned and to what, not just that some thinning happened.
  it('states how many samples were thinned and to what, when reduction is an object', () => {
    const { t, calls } = stubT()
    intradayBasis(t, { method: 'minmax', from: 5700, to: 720 }, 720)
    expect(calls).toEqual([['charts.intradayBasis.thinned', { from: 5700, to: 720 }]])
  })

  // The other half: null means nothing was thinned, so the card has to say these points ARE the
  // readings, not stay silent about the one distinction reduction exists to draw.
  it('states these points are the readings, when reduction is null', () => {
    const { t, calls } = stubT()
    intradayBasis(t, null, 42)
    expect(calls).toEqual([['charts.intradayBasis.full', { count: 42 }]])
  })
})
