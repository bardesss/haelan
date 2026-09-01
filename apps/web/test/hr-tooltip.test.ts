import { describe, it, expect } from 'vitest'
import { hrTooltip } from '../src/charts/hrTooltip.js'
import type { DayRow } from '../src/fixtures/july.js'
import type { Translate } from '../src/format.js'

// A hand rolled stand-in for i18next's own t(), the same device dayAnnotations.test.ts's own
// header comment explains: MESSAGES mirrors the real keys hrTooltip.ts reads
// (charts.absence.notWorn, charts.absence.noReading, charts.hrTooltip.mean,
// charts.hrTooltip.range), interpolated the same {{token}} way i18next itself does, so this file
// asserts what hrTooltip actually asked t() for rather than pinning translated copy a locale file
// is free to reword.
const MESSAGES: Record<string, string> = {
  'charts.absence.notWorn': 'not worn',
  'charts.absence.noReading': 'no reading',
  'charts.hrTooltip.mean': 'mean {{value}} bpm',
  'charts.hrTooltip.range': 'range {{min}} to {{max}} bpm',
}
const t: Translate = (key, options) => {
  let text = MESSAGES[key] ?? key
  if (options) for (const [k, v] of Object.entries(options)) text = text.replaceAll(`{{${k}}}`, String(v))
  return text
}

const worn: DayRow = { date: '2026-07-02', steps: 9000, hrMin: 52, hrMean: 71, hrMax: 128, sleepMinutes: 430, worn: true }
const notWorn: DayRow = { date: '2026-07-05', steps: null, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: false }
// The awkward middle case: the strap was on, so coverage counts this day, but
// the heart rate sensor produced nothing.
const wornNoMetric: DayRow = { ...worn, date: '2026-07-06', hrMin: null, hrMean: null, hrMax: null }
// The reported bug's own fixture: rollup.ts's weighted mean over real samples, unrounded. The
// exact mean value ("mean 90.18407633664866 bpm") is what a reader actually saw before this fix;
// min/max are given their own non-integer values too, rounding in opposite directions, so a fix
// that merely truncated rather than rounded would not pass silently.
const unrounded: DayRow = { ...worn, date: '2026-07-07', hrMin: 47.6, hrMean: 90.18407633664866, hrMax: 182.4 }

const days = [worn, notWorn, wornNoMetric, unrounded]

describe('heart rate tooltip', () => {
  it('reports a normal reading from the source row, not from the stacked series', () => {
    expect(hrTooltip(days, 0, t, 'en')).toBe('2026-07-02<br/>mean 71 bpm<br/>range 52 to 128 bpm')
  })

  it('says the device was not worn rather than showing an empty range', () => {
    expect(hrTooltip(days, 1, t, 'en')).toBe('2026-07-05<br/>not worn')
  })

  it('never lets a null reach the string as the literal text null', () => {
    expect(hrTooltip(days, 2, t, 'en')).toBe('2026-07-06<br/>no reading')
    expect(hrTooltip(days, 2, t, 'en')).not.toContain('null')
  })

  it('renders nothing for an index that is not a day', () => {
    expect(hrTooltip(days, 99, t, 'en')).toBe('')
    expect(hrTooltip(days, undefined, t, 'en')).toBe('')
  })

  // The reported bug, pinned directly: heart_rate's catalogue precision is 0 (metrics.ts), and
  // rollup.ts's weighted mean over real samples is essentially never a whole number. Before this
  // fix, hrTooltip interpolated day.hrMean/hrMin/hrMax raw, so a reader hovering this exact day
  // saw "mean 90.18407633664866 bpm". min rounds up (47.6 to 48) and max rounds down (182.4 to
  // 182), so a fix that only handled one rounding direction would not pass this either.
  it('rounds an unrounded weighted mean and range to heart_rate\'s own catalogue precision', () => {
    expect(hrTooltip(days, 3, t, 'en')).toBe('2026-07-07<br/>mean 90 bpm<br/>range 48 to 182 bpm')
  })

  // The other half of the reported bug: every word in this tooltip used to be a hardcoded English
  // literal, bypassing t() entirely, which is why a Dutch reader saw English words around the raw
  // number. Passing a t() that answers in a different vocabulary (uppercase, here, standing in for
  // a real locale) proves every word came from t() and none of them survived as a literal.
  it('routes every word through t(), not a hardcoded literal', () => {
    const shoutingT: Translate = (key, options) => t(key, options).toUpperCase()
    expect(hrTooltip(days, 0, shoutingT, 'en')).toBe('2026-07-02<br/>MEAN 71 BPM<br/>RANGE 52 TO 128 BPM')
    expect(hrTooltip(days, 1, shoutingT, 'en')).toBe('2026-07-05<br/>NOT WORN')
  })
})
