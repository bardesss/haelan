import { describe, it, expect } from 'vitest'
import { sleepSummary, isMainSleep } from '../src/api/sleepSummary.ts'

const ATTRS = {
  mainSleep: true,
  summary: {
    minutesToFallAsleep: '12', minutesAfterWakeUp: '4', minutesAsleep: '396',
    stagesSummary: [{ type: 'DEEP', minutes: '64', count: '4' }, { type: 'AWAKE', minutes: '25', count: '14' }],
  },
}

describe('sleepSummary', () => {
  it('reads the provider strings as numbers, times woken from the awake stage count', () => {
    expect(sleepSummary(ATTRS)).toEqual({ minutesToFallAsleep: 12, minutesAfterWakeUp: 4, awakenings: 14 })
  })
  it('is all null for a session with no summary, a classic night with no awake entry, or garbage', () => {
    expect(sleepSummary({ summary: null })).toEqual({ minutesToFallAsleep: null, minutesAfterWakeUp: null, awakenings: null })
    expect(sleepSummary({ summary: { stagesSummary: [{ type: 'DEEP', count: '2' }] } }).awakenings).toBeNull()
    expect(sleepSummary(null)).toEqual({ minutesToFallAsleep: null, minutesAfterWakeUp: null, awakenings: null })
  })
})

describe('isMainSleep', () => {
  it('reads the flag, and null when the provider never said', () => {
    expect(isMainSleep({ mainSleep: true })).toBe(true)
    expect(isMainSleep({ mainSleep: false })).toBe(false)
    expect(isMainSleep({})).toBeNull()
  })
})
