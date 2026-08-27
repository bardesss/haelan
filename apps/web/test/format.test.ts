import { describe, it, expect } from 'vitest'
import { formatDuration, formatClock, toneFor, toneOf, trend, deltaFor, metricIsClockOffset } from '../src/format.js'
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

  // A bedtime is measured from the midnight of the morning the night ended, so an 23:20 bedtime
  // arrives here as -40. Dashboard.tsx's inWindow keeps that page away from this case; nothing
  // stops the next caller, and the answer used to be the string "-1:-40".
  it('reads a minute before midnight as an evening clock time, not as a negative', () => {
    expect(formatClock(-40)).toBe('23:20')
    expect(formatClock(-1)).toBe('23:59')
    expect(formatClock(-24 * 60)).toBe('00:00')
    expect(formatClock(-25 * 60)).toBe('23:00')
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
    expect(d!.basis).toBe('t(common.trendBasis)')
  })

  it('reports direction and tone as separate facts', () => {
    const { t } = stubT()
    expect(trend(t, [2, 2, 1, 1], 'lower-is-better')).toMatchObject({ dir: 'down', tone: 'good' })
    expect(trend(t, [2, 2, 1, 1], 'higher-is-better')).toMatchObject({ dir: 'down', tone: 'bad' })
    expect(trend(t, [2, 2, 1, 1])).toMatchObject({ dir: 'down', tone: 'neutral' })
  })

  it('calls a swing under one per cent flat', () => {
    const { t } = stubT()
    expect(trend(t, [100, 100, 100, 100.5])!.dir).toBe('flat')
  })

  // The day range yields exactly one point per card, and an empty series reaches the same
  // slice() before any data has loaded. Both hand the split an empty first half, and 0 reduced
  // over nothing divided by a length of zero is NaN before either mean is compared, not after.
  it('reports no delta for zero or one values, rather than a delta reading NaN%', () => {
    const { t } = stubT()
    expect(trend(t, [])).toBeUndefined()
    expect(trend(t, [42])).toBeUndefined()
  })

  // A first half that legitimately averages to zero, a real reading rather than a gap, divides
  // by that zero and prints Infinity% instead of NaN%; same defect, different arithmetic route.
  it('reports no delta when the earlier half is zero, rather than a delta reading Infinity%', () => {
    const { t } = stubT()
    expect(trend(t, [0, 0, 5, 5])).toBeUndefined()
  })

  // The fix lives in one finite check after pct is computed, so this pins the ordinary path
  // (two or more values, a non-zero earlier half) to prove that check did not also swallow it.
  it('still reports a delta for two or more values with a non-zero earlier half', () => {
    const { t } = stubT()
    const d = trend(t, [1, 1, 1, 2, 2, 2], 'higher-is-better')
    expect(d).not.toBeUndefined()
    expect(d).toMatchObject({ dir: 'up', tone: 'good' })
  })
})

describe('metricIsClockOffset', () => {
  // Read off the catalogue's own unit rather than a list kept in the web app, so this asserts the
  // catalogue really carries the fact rather than that a duplicate list was typed correctly. If
  // metrics.ts ever renames the unit, this is what says so instead of two clock tiles quietly
  // regaining a percentage.
  it('names the two metrics whose values are clock positions', () => {
    expect(metricIsClockOffset('sleep_bedtime_minutes')).toBe(true)
    expect(metricIsClockOffset('sleep_waketime_minutes')).toBe(true)
  })

  // Duration metrics, which are minutes of something and do have meaningful ratios, must not be
  // caught by a unit test that matched on the substring "minutes".
  it('leaves ordinary minute durations and counts alone', () => {
    for (const metric of ['sleep_asleep_minutes', 'sleep_nap_minutes', 'workout_minutes', 'steps', 'heart_rate']) {
      expect(metricIsClockOffset(metric), metric).toBe(false)
    }
  })

  // A card wired to a metric nobody added to the catalogue is a mistake elsewhere; answering false
  // here keeps it a mistake about that card rather than a crash in every card's delta.
  it('answers false for a metric the catalogue does not carry', () => {
    expect(metricIsClockOffset('not_a_metric')).toBe(false)
  })
})

describe('deltaFor', () => {
  // The numbers the defect actually produced, kept here rather than only in a page test: a
  // fortnight moving from 23:58 to 23:30 is a person going to bed earlier, and trend() reads it as
  // a 1400% rise. deltaFor is what every page tile calls, so this is the assertion that says the
  // suppression is a property of the metric and not of whichever page drew it.
  it('shows no delta over a clock offset, whatever trend would have said about it', () => {
    const { t } = stubT()
    const bedtimes = [-2, -2, -30, -30]
    expect(trend(t, bedtimes)).toMatchObject({ dir: 'up', text: '↑ 1400%' })
    expect(deltaFor(t, 'sleep_bedtime_minutes', bedtimes, 'neutral')).toBeUndefined()
    expect(deltaFor(t, 'sleep_waketime_minutes', [360, 360, 450, 450], 'neutral')).toBeUndefined()
  })

  // The other half: an ordinary metric still gets exactly what trend() computes, so this is not a
  // helper that quietly suppresses everything.
  it('passes an ordinary metric straight through to trend', () => {
    const { t } = stubT()
    const values = [400, 400, 440, 440]
    expect(deltaFor(t, 'sleep_asleep_minutes', values, 'higher-is-better'))
      .toEqual(trend(t, values, 'higher-is-better'))
  })
})
