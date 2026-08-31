import { describe, it, expect } from 'vitest'
import { annotationsByDate } from '../src/charts/base.js'

describe('annotationsByDate', () => {
  it('passes a single annotation through unchanged', () => {
    expect(annotationsByDate([{ date: '2026-08-11', text: 'Watch left charging' }]))
      .toEqual([{ date: '2026-08-11', text: 'Watch left charging' }])
  })

  // The round 2 finding this function exists to close: an override reason, a note and an event can
  // all land on one date now, and HeartRateRange's markLine / ActivityHeatmap's markPoint used to
  // draw one entry per annotation at the same anchor. Joined here with the same ', ' the accessible
  // table already uses (Sparkline/ActivityHeatmap/HeartRateRange's own filter+join), so a chart
  // reading this function's output draws exactly one mark per date.
  it('joins several annotations sharing one date into a single entry, in the order they were given', () => {
    const result = annotationsByDate([
      { date: '2026-08-11', text: 'Watch left charging' },
      { date: '2026-08-11', text: 'Flew to Tokyo' },
      { date: '2026-08-11', text: 'Illness' },
    ])
    expect(result).toEqual([{ date: '2026-08-11', text: 'Watch left charging, Flew to Tokyo, Illness' }])
  })

  it('keeps annotations on different dates apart, each its own entry', () => {
    const result = annotationsByDate([
      { date: '2026-08-10', text: 'a' },
      { date: '2026-08-11', text: 'b' },
    ])
    expect(result).toEqual([{ date: '2026-08-10', text: 'a' }, { date: '2026-08-11', text: 'b' }])
  })

  it('returns an empty array for no annotations', () => {
    expect(annotationsByDate([])).toEqual([])
  })
})
