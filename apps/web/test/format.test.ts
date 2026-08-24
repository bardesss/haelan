import { describe, it, expect } from 'vitest'
import { formatDuration, formatClock, toneFor, toneOf, trend } from '../src/format.js'
import type { Translate } from '../src/format.js'

// A stub, not a real i18n instance: trend() only needs something call-shaped like `t`, and a
// test that pins one language's prose here is the exact problem this fix exists to remove. The
// stub is deliberately traceable rather than transparent: it names both the key and every
// interpolation value it was called with, so a test can assert on what trend() asked for
// without also asserting what a translator wrote back.
function stubT(): { t: Translate, calls: [string, Record<string, unknown> | undefined][] } {
  const calls: [string, Record<string, unknown> | undefined][] = []
  const t: Translate = (key, options) => {
    calls.push([key, options])
    return `t(${key})`
  }
  return { t, calls }
}

describe('formatDuration', () => {
  it('rounds to whole minutes before splitting, not after', () => {
    // Splitting first gives 6h and round(59.6)m, which renders as "6h 60m".
    expect(formatDuration(419.6)).toBe('7h 00m')
    expect(formatDuration(59.5)).toBe('1h 00m')
    expect(formatDuration(0)).toBe('0h 00m')
    expect(formatDuration(419)).toBe('6h 59m')
    expect(formatDuration(480)).toBe('8h 00m')
  })
})

describe('formatClock', () => {
  it('wraps past midnight and never renders a sixtieth minute', () => {
    expect(formatClock(23 * 60 + 59.6)).toBe('00:00')
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(23 * 60 + 30)).toBe('23:30')
    expect(formatClock(25 * 60)).toBe('01:00')
  })
})

describe('tone', () => {
  it.each([
    ['up', 'higher-is-better', 'good'],
    ['down', 'higher-is-better', 'bad'],
    ['up', 'lower-is-better', 'bad'],
    ['down', 'lower-is-better', 'good'],
    ['up', 'neutral', 'neutral'],
    ['down', 'neutral', 'neutral'],
    ['flat', 'higher-is-better', 'neutral'],
    ['flat', 'lower-is-better', 'neutral'],
    ['flat', 'neutral', 'neutral'],
  ] as const)('reads %s under %s as %s', (dir, polarity, expected) => {
    expect(toneFor(dir, polarity)).toBe(expected)
  })

  // The defect this closes: a delta with no stated polarity used to be coloured
  // as though a judgement had been made, which put a green rising arrow beside a
  // climbing resting heart rate.
  it('defaults an unstated tone to neutral rather than guessing', () => {
    expect(toneOf(undefined)).toBe('neutral')
    expect(toneOf({ text: '↑ 4%', dir: 'up' })).toBe('neutral')
    expect(toneOf({ text: '↑ 4%', dir: 'up', tone: 'good' })).toBe('good')
  })
})

describe('trend', () => {
  it('asks the catalogue for the window it compared, rather than baking English prose', () => {
    // The window sizes are the fact worth stating; the sentence around them belongs to
    // whichever catalogue `t` was resolved from, not to this function.
    const { t, calls } = stubT()
    const d = trend(t, [1, 1, 1, 2, 2, 2], 'higher-is-better')
    expect(calls).toEqual([['common.trendBasis', { recent: 3, earlier: 3 }]])
    expect(d.basis).toBe('t(common.trendBasis)')
  })

  it('reports direction and tone as separate facts', () => {
    const { t } = stubT()
    expect(trend(t, [2, 2, 1, 1], 'lower-is-better')).toMatchObject({ dir: 'down', tone: 'good' })
    expect(trend(t, [2, 2, 1, 1], 'higher-is-better')).toMatchObject({ dir: 'down', tone: 'bad' })
    expect(trend(t, [2, 2, 1, 1])).toMatchObject({ dir: 'down', tone: 'neutral' })
  })

  it('calls a swing under one per cent flat', () => {
    const { t } = stubT()
    expect(trend(t, [100, 100, 100, 100.5]).dir).toBe('flat')
  })
})
