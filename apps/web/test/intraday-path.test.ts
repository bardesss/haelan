import { describe, expect, it } from 'vitest'
import { intradayPath, INTRADAY_POINTS } from '../src/data/useIntraday.js'
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
