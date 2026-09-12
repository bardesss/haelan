import { describe, it, expect } from 'vitest'
import { oneNightPerDate, stageOf } from '../src/data/nights.js'
import type { Night } from '../src/data/useNights.js'

const night = (localDate: string, sourceId: string, hours: number): Night => ({
  localDate, sourceId, sessionIds: [`${sourceId}-${localDate}`],
  startMs: Date.UTC(2026, 7, 3, 22, 0), endMs: Date.UTC(2026, 7, 3, 22, 0) + hours * 3_600_000,
  startOffsetMinutes: 120, endOffsetMinutes: 120, naps: [], segments: [], excludedSessions: [],
})

describe('oneNightPerDate', () => {
  it('keeps the longer recording when two sources report the same date', () => {
    // A second device sharing the date is more likely a short partial recording than the source
    // that stayed on through the whole night.
    const picked = oneNightPerDate([night('2026-08-03', 'phone', 3), night('2026-08-03', 'watch', 8)])
    expect(picked.map((n) => n.sourceId)).toEqual(['watch'])
  })

  it('keeps one row per date and orders them by date', () => {
    const picked = oneNightPerDate([
      night('2026-08-04', 'watch', 7), night('2026-08-03', 'watch', 8), night('2026-08-03', 'phone', 2),
    ])
    expect(picked.map((n) => `${n.localDate}/${n.sourceId}`)).toEqual(['2026-08-03/watch', '2026-08-04/watch'])
  })

  it('answers an empty list for no nights at all', () => {
    expect(oneNightPerDate([])).toEqual([])
  })
})

describe('stageOf', () => {
  it('recognises the four staged values a hypnogram draws', () => {
    expect([stageOf('DEEP'), stageOf('LIGHT'), stageOf('REM'), stageOf('AWAKE')])
      .toEqual(['deep', 'light', 'rem', 'awake'])
  })

  it('answers null for a value nobody staged, rather than guessing LIGHT', () => {
    // ASLEEP and RESTLESS are recognised by the derive layer and are not staged: drawn as LIGHT
    // they would be a stage this device never reported. A gap in the hypnogram is the honest
    // rendering.
    expect(stageOf('ASLEEP')).toBeNull()
    expect(stageOf('RESTLESS')).toBeNull()
    expect(stageOf('SOMETHING_NEW')).toBeNull()
  })
})
