import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NightStages } from '../src/pages/sleep/NightStages.js'
import type { Night } from '../src/data/useNights.js'

const BASE: Night = {
  localDate: '2026-08-03', sourceId: 'watch', sessionIds: ['s1'],
  startMs: Date.UTC(2026, 7, 2, 21, 15), endMs: Date.UTC(2026, 7, 3, 5, 2),
  startOffsetMinutes: 120, endOffsetMinutes: 120,
  naps: [], segments: [], excludedSessions: [],
}

const segment = (stage: string, fromMinutes: number, toMinutes: number) => ({
  stage,
  startMs: BASE.startMs + fromMinutes * 60_000,
  endMs: BASE.startMs + toMinutes * 60_000,
})

describe('the night stages card', () => {
  it('renders nothing at all when the night carries no staged segments', () => {
    // A device that recorded a span but no stages leaves nothing for a hypnogram to draw, and an
    // empty chart would claim a night with no deep, light or REM sleep in it.
    expect(renderToStaticMarkup(<NightStages night={BASE} />)).toBe('')
  })

  it('drops a segment nobody staged rather than drawing it as light sleep', () => {
    const night = { ...BASE, segments: [segment('DEEP', 0, 60), segment('RESTLESS', 60, 70)] }
    const html = renderToStaticMarkup(<NightStages night={night} />)
    // The accessible table ChartFigure renders is where the drawn segments are readable as text.
    expect(html).toContain('sleep.stage.deep')
    expect(html).not.toContain('RESTLESS')
  })

  it('lists a nap by its own clock time', () => {
    const night = {
      ...BASE,
      segments: [segment('DEEP', 0, 60)],
      naps: [Date.UTC(2026, 7, 3, 12, 30)],
    }
    expect(renderToStaticMarkup(<NightStages night={night} />)).toContain('14:30')
  })

  it('says a night recorded no naps rather than showing nothing', () => {
    // Empty means the route looked and found none, which is what the field already means.
    const night = { ...BASE, segments: [segment('DEEP', 0, 60)] }
    expect(renderToStaticMarkup(<NightStages night={night} />)).toContain('sleep.night.naps.none')
  })

  it('says a session was thrown out of this night, and how many', () => {
    const night = { ...BASE, segments: [segment('DEEP', 0, 60)], excludedSessions: ['s2', 's3'] }
    expect(renderToStaticMarkup(<NightStages night={night} />))
      .toContain('sleep.sleepStages.nightExcludedSessions')
  })
})
