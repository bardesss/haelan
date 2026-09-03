import { describe, expect, it } from 'vitest'
import { trendPath } from '../src/data/useTrend.js'
import { ALL_SOURCES } from '../src/controls/source.js'

describe('trendPath', () => {
  it('sends the metric, agg and window', () => {
    const path = trendPath('p1', {
      metric: 'weight', agg: 'last', from: '2026-08-01', to: '2026-08-31', source: ALL_SOURCES,
    })
    expect(path).toContain('metric=weight')
    expect(path).toContain('agg=last')
    expect(path).toContain('from=2026-08-01')
    expect(path).toContain('to=2026-08-31')
  })

  // The same sentinel defect exportPathFor shipped: requireSource knows no source called 'all'.
  it('omits the all sources sentinel rather than sending it', () => {
    const path = trendPath('p1', {
      metric: 'weight', agg: 'last', from: '2026-08-01', to: '2026-08-31', source: ALL_SOURCES,
    })
    expect(path).not.toContain('source=')
  })
})
