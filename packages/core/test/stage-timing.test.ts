import { describe, expect, it } from 'vitest'
import { stageTimingOf } from '../src/query/stageTiming.ts'

const M = 60_000
/** A segment from minute `from` to minute `to` of the night. */
const seg = (stage: string, from: number, to: number) => ({ stage, startMs: from * M, endMs: to * M })

describe('stageTimingOf', () => {
  it('measures first deep and first REM from sleep onset, and counts one REM episode', () => {
    const night = [
      seg('LIGHT', 0, 52), seg('DEEP', 52, 116), seg('LIGHT', 116, 175),
      seg('REM', 175, 298), seg('AWAKE', 298, 323), seg('LIGHT', 323, 421),
    ]
    expect(stageTimingOf(night)).toEqual({ firstDeepMinutes: 52, firstRemMinutes: 175, cycles: 1 })
  })

  it('keeps REM segments 15 minutes apart as one episode, and splits them at 25', () => {
    const base = [seg('LIGHT', 0, 60), seg('REM', 60, 80)]
    expect(stageTimingOf([...base, seg('LIGHT', 80, 95), seg('REM', 95, 110)]).cycles).toBe(1)
    expect(stageTimingOf([...base, seg('LIGHT', 80, 105), seg('REM', 105, 120)]).cycles).toBe(2)
  })

  it('starts a new episode at exactly the gap', () => {
    expect(stageTimingOf([seg('LIGHT', 0, 60), seg('REM', 60, 80), seg('LIGHT', 80, 100), seg('REM', 100, 110)]).cycles).toBe(2)
  })

  it('keeps one episode when a short REM segment lies inside a longer one', () => {
    // The long segment ends at 120, after the short one nested in it; measured from the short
    // one's end (90), the next REM at 125 would be 35 minutes on and split the episode.
    const night = [seg('LIGHT', 0, 60), seg('REM', 60, 120), seg('REM', 70, 90), seg('REM', 125, 140)]
    expect(stageTimingOf(night).cycles).toBe(1)
  })

  it('says nothing about a classic night', () => {
    expect(stageTimingOf([seg('ASLEEP', 0, 200), seg('RESTLESS', 200, 210), seg('ASLEEP', 210, 400)]))
      .toEqual({ firstDeepMinutes: null, firstRemMinutes: null, cycles: null })
  })

  it('says nothing about a night with nothing asleep in it', () => {
    expect(stageTimingOf([seg('AWAKE', 0, 30)])).toEqual({ firstDeepMinutes: null, firstRemMinutes: null, cycles: null })
  })

  it('measures from the first asleep segment, not from an awake start', () => {
    const night = [seg('AWAKE', 0, 10), seg('LIGHT', 10, 40), seg('DEEP', 40, 90), seg('REM', 90, 120)]
    expect(stageTimingOf(night)).toEqual({ firstDeepMinutes: 30, firstRemMinutes: 80, cycles: 1 })
  })

  it('reads segments in time order whatever order they arrive in', () => {
    const night = [seg('REM', 90, 120), seg('DEEP', 40, 90), seg('LIGHT', 10, 40), seg('AWAKE', 0, 10)]
    expect(stageTimingOf(night)).toEqual({ firstDeepMinutes: 30, firstRemMinutes: 80, cycles: 1 })
  })

  it('leaves REM timing and cycles null on a night with deep sleep but no REM', () => {
    expect(stageTimingOf([seg('LIGHT', 0, 30), seg('DEEP', 30, 90)]))
      .toEqual({ firstDeepMinutes: 30, firstRemMinutes: null, cycles: null })
  })
})
