import { describe, it, expect } from 'vitest'
import { periodLabel } from '../src/controls/periodLabel.js'
import { RANGE_KEYS } from '../src/controls/range.js'

// Dutch for most of these because that is the locale the defect was reported in, and because a
// label built from Intl rather than the catalogue is exactly the kind of string that silently
// stays English. The expected values were read out of this Node's own ICU rather than guessed:
// short month names carry a trailing period in some ICU versions and none in others, so an
// asserted "jul." would have been a test about the runtime instead of about this function.
describe('periodLabel', () => {
  it('names a single day in full, whichever tab produced it', () => {
    expect(periodLabel('day', '2026-09-03', '2026-09-03', 'nl')).toBe('3 september 2026')
    // A week tab whose two ends collapsed to one day takes the same branch on purpose: the label
    // describes the period it was handed, not the button that was pressed.
    expect(periodLabel('week', '2026-09-03', '2026-09-03', 'nl')).toBe('3 september 2026')
  })

  it('names a calendar month by its month name', () => {
    expect(periodLabel('month', '2026-08-01', '2026-08-31', 'nl')).toBe('augustus 2026')
    expect(periodLabel('month', '2026-08-01', '2026-08-31', 'en')).toBe('August 2026')
  })

  // The one that would state something false rather than merely long. A month-tab window whose
  // ends straddle a boundary is not a calendar month, and printing either month's name for it
  // would name a period the reader is not looking at.
  it('refuses to call a straddling window a month, and falls back to its days', () => {
    expect(periodLabel('month', '2026-08-15', '2026-09-14', 'nl')).toBe('15 aug - 14 sep 2026')
  })

  it('names a year by its number, and a straddling one by both', () => {
    expect(periodLabel('year', '2026-01-01', '2026-12-31', 'nl')).toBe('2026')
    expect(periodLabel('year', '2026-07-01', '2027-06-30', 'nl')).toBe('2026 - 2027')
  })

  it('names a quarter by its months, printing the year once or twice as needed', () => {
    expect(periodLabel('3months', '2026-07-01', '2026-09-30', 'nl')).toBe('jul - sep 2026')
    expect(periodLabel('3months', '2026-11-01', '2027-01-31', 'nl')).toBe('nov 2026 - jan 2027')
  })

  it('names a week by its two days, printing the year once or twice as needed', () => {
    expect(periodLabel('week', '2026-08-31', '2026-09-06', 'nl')).toBe('31 aug - 6 sep 2026')
    expect(periodLabel('week', '2026-12-31', '2027-01-06', 'nl')).toBe('31 dec 2026 - 6 jan 2027')
  })

  // Enumerated rather than spot checked, the same reason metrics-subpath.test.ts enumerates: a
  // sixth range key would otherwise fall through to the day-precision branch at the bottom and
  // print something plausible for a period that branch was never meant to describe. This goes red
  // when RANGE_KEYS grows, which is the point.
  it('gives every range key a label that is shorter than the bounds it replaced and prints no ISO date', () => {
    for (const tab of RANGE_KEYS) {
      const label = periodLabel(tab, '2026-08-01', '2026-08-31', 'nl')
      expect(label, tab).not.toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(label.length, tab).toBeLessThan('2026-08-01 tot en met 2026-08-31'.length)
      expect(label.trim(), tab).not.toBe('')
    }
  })

  // These strings are calendar dates carrying no zone. Parsing one through a zone behind UTC lands
  // on the previous day, which renames every period that starts on the 1st: an August month view
  // prints "juli 2026". The machine this suite normally runs on is ahead of UTC, where the bug is
  // invisible, so the zone is switched here rather than assumed.
  it('names the month a period starts in, even where UTC midnight is the previous day', () => {
    const original = process.env.TZ
    try {
      process.env.TZ = 'America/Los_Angeles'
      // The switch is asserted before anything depends on it. Without this line a runtime that
      // ignores a mid-run TZ change makes the two assertions below pass for the wrong reason, and
      // this test would be proving nothing on exactly the platforms it exists to cover.
      expect(new Date('2026-08-01T00:00:00Z').getDate(), 'TZ did not take effect').toBe(31)
      expect(periodLabel('month', '2026-08-01', '2026-08-31', 'nl')).toBe('augustus 2026')
      expect(periodLabel('day', '2026-01-01', '2026-01-01', 'nl')).toBe('1 januari 2026')
    } finally {
      // finally, not a trailing statement: a failed assertion above would otherwise leave every
      // later test in the run sitting in Los Angeles.
      process.env.TZ = original
    }
  })
})
