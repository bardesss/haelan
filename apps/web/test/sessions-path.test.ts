import { describe, expect, it } from 'vitest'
import { sessionsPath } from '../src/data/useSessions.js'
import { ALL_SOURCES } from '../src/controls/source.js'

const RANGE = { kind: 'exercise' as const, from: '2026-08-01', to: '2026-08-31' }

describe('sessionsPath', () => {
  it('sends the kind and the window', () => {
    const path = sessionsPath('p1', { ...RANGE, source: ALL_SOURCES })
    expect(path).toContain('kind=exercise')
    expect(path).toContain('from=2026-08-01')
    expect(path).toContain('to=2026-08-31')
  })

  // The defect the M3 phase review found in exportPathFor, which sent the sentinel literally and
  // 400ed the download link on every page. requireSource knows no source called 'all'.
  it('omits the all sources sentinel rather than sending it', () => {
    expect(sessionsPath('p1', { ...RANGE, source: ALL_SOURCES })).not.toContain('source=')
  })

  it('sends a real device source through unchanged', () => {
    expect(sessionsPath('p1', { ...RANGE, source: 'watch-1' })).toContain('source=watch-1')
  })
})
