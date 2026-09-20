import { describe, it, expect } from 'vitest'
import { datesFor, stepAnchor, parseControls, clampFromToHistory } from '../src/controls/range.js'
import { normalizeHistoryStart, historyStartPath } from '../src/data/useHistoryStart.js'
import { ALL_SOURCES } from '../src/controls/source.js'

describe('datesFor', () => {
  it('gives a single day for the day tab', () => {
    expect(datesFor('day', '2026-08-15')).toEqual({ from: '2026-08-15', to: '2026-08-15' })
  })

  // Monday to Sunday regardless of locale. Both languages this app ships start the week on
  // Monday, and a week whose meaning depends on the reader is not a week a link can carry.
  it('gives Monday to Sunday for the week tab', () => {
    expect(datesFor('week', '2026-08-15')).toEqual({ from: '2026-08-10', to: '2026-08-16' })
  })

  it('treats a Sunday as the end of its week, not the start of the next', () => {
    expect(datesFor('week', '2026-08-16')).toEqual({ from: '2026-08-10', to: '2026-08-16' })
  })

  it('gives the whole calendar month, including a 31 day one', () => {
    expect(datesFor('month', '2026-08-15')).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('gives 29 days for February in a leap year', () => {
    expect(datesFor('month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })

  it('gives 28 days for February in a common year', () => {
    expect(datesFor('month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })

  // Three calendar months ending with the anchor's month, not 90 days.
  it('gives three whole months for the 3months tab', () => {
    expect(datesFor('3months', '2026-08-15')).toEqual({ from: '2026-06-01', to: '2026-08-31' })
  })

  it('crosses a year boundary for the 3months tab', () => {
    expect(datesFor('3months', '2026-01-15')).toEqual({ from: '2025-11-01', to: '2026-01-31' })
  })

  it('gives January to December for the year tab', () => {
    expect(datesFor('year', '2026-08-15')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })
})

describe('stepAnchor', () => {
  it('steps one day', () => {
    expect(stepAnchor('day', '2026-08-15', 1)).toBe('2026-08-16')
    expect(stepAnchor('day', '2026-08-01', -1)).toBe('2026-07-31')
  })

  it('steps one week', () => {
    expect(stepAnchor('week', '2026-08-15', 1)).toBe('2026-08-22')
  })

  // The anchor keeps its day of month where the target month has one. This is the case that
  // silently produces 2026-03-03 in a naive implementation.
  it('steps one month without overflowing a short month', () => {
    expect(stepAnchor('month', '2026-01-31', 1)).toBe('2026-02-28')
    expect(stepAnchor('month', '2026-03-31', -1)).toBe('2026-02-28')
  })

  it('steps three months', () => {
    expect(stepAnchor('3months', '2026-08-15', -1)).toBe('2026-05-15')
  })

  it('steps one year, and clamps 29 February onto a common year', () => {
    expect(stepAnchor('year', '2026-08-15', 1)).toBe('2027-08-15')
    expect(stepAnchor('year', '2028-02-29', 1)).toBe('2029-02-28')
  })
})

describe('parseControls', () => {
  const today = '2026-08-26'

  it('defaults an empty search to the month containing today, all sources', () => {
    expect(parseControls('', today)).toEqual({ tab: 'month', anchor: today, source: ALL_SOURCES })
  })

  it('reads all three parameters', () => {
    expect(parseControls('?range=week&on=2026-08-15&source=watch', today))
      .toEqual({ tab: 'week', anchor: '2026-08-15', source: 'watch' })
  })

  // A hand edited or stale URL is an ordinary thing to receive, not an exception to throw on.
  it('falls back on an unknown range rather than throwing', () => {
    expect(parseControls('?range=fortnight', today).tab).toBe('month')
  })

  it('falls back on a malformed date', () => {
    expect(parseControls('?on=15-08-2026', today).anchor).toBe(today)
  })

  it('falls back on a date the calendar does not have', () => {
    expect(parseControls('?on=2026-02-30', today).anchor).toBe(today)
    expect(parseControls('?on=2026-13-01', today).anchor).toBe(today)
  })

  it('accepts a leap day in a leap year', () => {
    expect(parseControls('?on=2028-02-29', today).anchor).toBe('2028-02-29')
  })

  // The remembered range reaches this function as an argument rather than being read here: this
  // module is pure date arithmetic and string parsing, and the only reason it knew the word
  // 'month' at all was that something had to decide. Now the caller decides and this still just
  // parses.
  describe('with a remembered range', () => {
    it('uses it when the URL names no range', () => {
      expect(parseControls('', today, 'week').tab).toBe('week')
    })

    // The whole point of leaving the URL authoritative: a link someone was sent, a deep link, and
    // the demo's canonical URLs all have to mean what they say regardless of what the reader
    // happens to have looked at last.
    it('is overruled by a range the URL does name', () => {
      expect(parseControls('?range=year', today, 'week').tab).toBe('year')
    })

    // A URL that names no usable range has said nothing, which is the same position as a URL that
    // named none at all.
    it('is used when the URL names a range this app does not have', () => {
      expect(parseControls('?range=fortnight', today, 'week').tab).toBe('week')
    })

    it('leaves the anchor and the source alone', () => {
      expect(parseControls('', today, 'week')).toEqual({ tab: 'week', anchor: today, source: ALL_SOURCES })
    })
  })
})

describe('clampFromToHistory', () => {
  // A phone-only history starting 2026-09-13T10:00:00Z, read in the person's own zone.
  const history = { historyStartMs: Date.parse('2026-09-13T10:00:00Z'), googleConnected: false }
  const timezone = 'Europe/Amsterdam'

  it('starts the range on the history start instead of the tab start', () => {
    expect(clampFromToHistory('2026-09-01', '2026-09-30', history, timezone)).toBe('2026-09-13')
  })

  it('leaves a range that starts after the history alone', () => {
    expect(clampFromToHistory('2026-09-20', '2026-09-30', history, timezone)).toBe('2026-09-20')
  })

  it('leaves the range alone without a history start', () => {
    const none = { historyStartMs: null as number | null, googleConnected: false }
    expect(clampFromToHistory('2026-09-01', '2026-09-30', none, timezone)).toBe('2026-09-01')
  })

  it('never clamps a person who also walks the Google path', () => {
    const mixed = { ...history, googleConnected: true }
    expect(clampFromToHistory('2026-09-01', '2026-09-30', mixed, timezone)).toBe('2026-09-01')
  })

  it('never inverts a range that ends before the history starts', () => {
    expect(clampFromToHistory('2026-08-01', '2026-08-31', history, timezone)).toBe('2026-08-01')
  })

  it('reads a body with nothing numeric in it as no history', () => {
    expect(normalizeHistoryStart({} as never))
      .toEqual({ historyStartMs: null, googleConnected: false, lastIngestAtMs: null })
    expect(normalizeHistoryStart({ historyStartMs: 'soon' as never, googleConnected: 0 as never }))
      .toEqual({ historyStartMs: null, googleConnected: false, lastIngestAtMs: null })
  })

  it('takes the newest ingest across every type, ignoring the types that have none', () => {
    // The question the staleness line asks is whether the phone is reaching this instance at all,
    // so one type that arrived an hour ago answers it whatever the others say. A type that has
    // never been sent carries null and must not read as an ingest at time zero.
    expect(normalizeHistoryStart({
      historyStartMs: 1000, googleConnected: false,
      items: [
        { dataTypeId: 'steps', lastWindowEndMs: 9, lastIngestAtMs: 500 },
        { dataTypeId: 'weight', lastWindowEndMs: null, lastIngestAtMs: null },
        { dataTypeId: 'heart-rate', lastWindowEndMs: 9, lastIngestAtMs: 900 },
      ],
    })).toEqual({ historyStartMs: 1000, googleConnected: false, lastIngestAtMs: 900 })
  })

  it('reads a body whose items are missing or not a list as no ingest', () => {
    expect(normalizeHistoryStart({ historyStartMs: 1, googleConnected: true }).lastIngestAtMs).toBe(null)
    expect(normalizeHistoryStart({ historyStartMs: 1, googleConnected: true, items: 'none' as never })
      .lastIngestAtMs).toBe(null)
  })

  it('asks the companion cursors for this person as an Android client', () => {
    expect(historyStartPath('p1')).toBe('/api/v1/p/p1/companion/cursors?platform=android')
  })
})
