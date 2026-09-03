import { describe, expect, it } from 'vitest'
import { intradayPath, INTRADAY_POINTS, type IntradayResult } from '../src/data/useIntraday.js'
import { ALL_SOURCES } from '../src/controls/source.js'

describe('intradayPath', () => {
  // The parameter is `date`. The server reads request.query.date (tier2.ts) and the spec that
  // described this route called it localDate, which would 400 on every request while looking like
  // a server fault. Asserted by name rather than by shape for that reason.
  it('names the date parameter date, and sends the downsample target', () => {
    const path = intradayPath('p1', { metric: 'heart_rate', date: '2026-08-13', source: ALL_SOURCES })
    expect(path).toContain('date=2026-08-13')
    expect(path).not.toContain('localDate')
    expect(path).toContain(`points=${INTRADAY_POINTS}`)
    expect(path).toContain('metric=heart_rate')
  })

  // The defect the M3 phase review found in exportPathFor, which sent the sentinel literally and
  // 400ed the download link on every page. requireSource knows no source called 'all'.
  it('omits the all sources sentinel rather than sending it', () => {
    const path = intradayPath('p1', { metric: 'heart_rate', date: '2026-08-13', source: ALL_SOURCES })
    expect(path).not.toContain('source=')
  })

  it('sends a real device source through unchanged', () => {
    const path = intradayPath('p1', { metric: 'heart_rate', date: '2026-08-13', source: 'watch-1' })
    expect(path).toContain('source=watch-1')
  })
})

describe('IntradayResult type', () => {
  // When nothing was thinned, the response holds the full series and reduction is null. A consumer
  // needs to know whether 400 points represent a complete day or a thinned one standing in for
  // tens of thousands, because a basis line anchors differently in each case.
  it('accepts reduction as null when the full series fits the points budget', () => {
    const result: IntradayResult = {
      points: [
        { sourceId: 'watch-1', utcMs: 1723228800000, min: 60, mean: 65, max: 70 },
        { sourceId: 'watch-1', utcMs: 1723228920000, min: 62, mean: 66, max: 71 },
      ],
      reduction: null,
    }
    expect(result.reduction).toBeNull()
    expect(result.points).toHaveLength(2)
  })

  // When the series was thinned, reduction carries the method (lttb for visual shape, minmax for
  // range bands), the count before thinning, and the count after, so the chart knows it is looking
  // at a lossy summary of a larger series.
  it('accepts reduction as an object when the series was thinned', () => {
    const result: IntradayResult = {
      points: [
        { sourceId: 'watch-1', utcMs: 1723228800000, min: 60, mean: 65, max: 70 },
        { sourceId: 'watch-1', utcMs: 1723228920000, min: 62, mean: 66, max: 71 },
      ],
      reduction: { method: 'lttb', from: 5700, to: 720 },
    }
    expect(result.reduction).not.toBeNull()
    if (result.reduction !== null) {
      expect(result.reduction.method).toBe('lttb')
      expect(result.reduction.from).toBe(5700)
      expect(result.reduction.to).toBe(720)
    }
  })
})
