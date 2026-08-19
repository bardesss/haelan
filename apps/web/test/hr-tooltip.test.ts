import { describe, it, expect } from 'vitest'
import { hrTooltip } from '../src/charts/hrTooltip.js'
import type { DayRow } from '../src/fixtures/july.js'

const worn: DayRow = { date: '2026-07-02', steps: 9000, hrMin: 52, hrMean: 71, hrMax: 128, sleepMinutes: 430, worn: true }
const notWorn: DayRow = { date: '2026-07-05', steps: null, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: false }
// The awkward middle case: the strap was on, so coverage counts this day, but
// the heart rate sensor produced nothing.
const wornNoMetric: DayRow = { ...worn, date: '2026-07-06', hrMin: null, hrMean: null, hrMax: null }

const days = [worn, notWorn, wornNoMetric]

describe('heart rate tooltip', () => {
  it('reports a normal reading from the source row, not from the stacked series', () => {
    expect(hrTooltip(days, 0)).toBe('2026-07-02<br/>mean 71 bpm<br/>range 52 to 128 bpm')
  })

  it('says the device was not worn rather than showing an empty range', () => {
    expect(hrTooltip(days, 1)).toBe('2026-07-05<br/>not worn')
  })

  it('never lets a null reach the string as the literal text null', () => {
    expect(hrTooltip(days, 2)).toBe('2026-07-06<br/>no data')
    expect(hrTooltip(days, 2)).not.toContain('null')
  })

  it('renders nothing for an index that is not a day', () => {
    expect(hrTooltip(days, 99)).toBe('')
    expect(hrTooltip(days, undefined)).toBe('')
  })
})
