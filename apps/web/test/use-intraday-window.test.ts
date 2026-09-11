import { describe, expect, it } from 'vitest'
import { intradayWindowPath } from '../src/data/useIntradayWindow.js'
import { INTRADAY_POINTS } from '../src/data/useIntraday.js'
import { ALL_SOURCES } from '../src/controls/source.js'

const FROM = Date.UTC(2026, 7, 18, 22, 0)
const TO = FROM + 3_600_000

describe('intradayWindowPath', () => {
  it('sends the metric, both bounds and the shared points budget', () => {
    const path = intradayWindowPath('p1', {
      metric: 'heart_rate', startMs: FROM, endMs: TO, source: ALL_SOURCES,
    })
    const params = new URLSearchParams(path.split('?')[1])

    expect(path.startsWith('/api/v1/p/p1/intraday/window?')).toBe(true)
    expect(params.get('metric')).toBe('heart_rate')
    expect(params.get('startMs')).toBe(String(FROM))
    expect(params.get('endMs')).toBe(String(TO))
    // The same constant the day read uses, not a second one. A workout is far shorter than 720
    // minutes so its series comes back whole; a night is thinned. Both behaviours already exist.
    expect(params.get('points')).toBe(String(INTRADAY_POINTS))
  })

  it('omits the all sources sentinel rather than sending it literally', () => {
    const path = intradayWindowPath('p1', {
      metric: 'heart_rate', startMs: FROM, endMs: TO, source: ALL_SOURCES,
    })
    // The server knows no source called 'all'; sending it literally 400s every request at the
    // default view, which is the defect the M3 phase review found in exportPathFor.
    expect(new URLSearchParams(path.split('?')[1]).has('source')).toBe(false)
  })

  it('sends a real source id through unchanged', () => {
    const path = intradayWindowPath('p1', {
      metric: 'heart_rate', startMs: FROM, endMs: TO, source: 'watch',
    })
    expect(new URLSearchParams(path.split('?')[1]).get('source')).toBe('watch')
  })
})
