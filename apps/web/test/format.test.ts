import { describe, it, expect } from 'vitest'
import { formatDuration, formatClock, toneFor, toneOf, trend } from '../src/format.js'

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
  it('states the window it compared', () => {
    const d = trend([1, 1, 1, 2, 2, 2], 'higher-is-better')
    expect(d.basis).toBe('change is the mean of the last 3 readings against the first 3')
  })

  it('reports direction and tone as separate facts', () => {
    expect(trend([2, 2, 1, 1], 'lower-is-better')).toMatchObject({ dir: 'down', tone: 'good' })
    expect(trend([2, 2, 1, 1], 'higher-is-better')).toMatchObject({ dir: 'down', tone: 'bad' })
    expect(trend([2, 2, 1, 1])).toMatchObject({ dir: 'down', tone: 'neutral' })
  })

  it('calls a swing under one per cent flat', () => {
    expect(trend([100, 100, 100, 100.5]).dir).toBe('flat')
  })
})
