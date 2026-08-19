import { describe, expect, it } from 'vitest'
import { DATA_TYPES, dataTypeById } from '../src/api/catalogue.ts'

describe('data type catalogue', () => {
  it('declares every type the v1 pages need', () => {
    const ids = DATA_TYPES.map((t) => t.id)
    for (const required of [
      'steps', 'distance', 'active-minutes', 'active-energy-burned', 'exercise',
      'heart-rate', 'daily-resting-heart-rate', 'heart-rate-variability',
      'oxygen-saturation', 'daily-respiratory-rate', 'sleep', 'weight', 'body-fat',
    ]) expect(ids, required).toContain(required)
  })

  it('uses kebab in the path and snake in the filter, because the API does', () => {
    for (const t of DATA_TYPES) {
      expect(t.id, t.id).not.toMatch(/_/)
      expect(t.filterRoot, t.id).toBe(t.id.replaceAll('-', '_'))
    }
  })

  it('gives the payload key in camel, which is neither of the other two', () => {
    const hr = dataTypeById('heart-rate')
    expect(hr?.payloadKey).toBe('heartRate')
    expect(dataTypeById('daily-resting-heart-rate')?.payloadKey).toBe('dailyRestingHeartRate')
  })

  it('records the filter member measured against the live API, not a guess', () => {
    expect(dataTypeById('steps')?.filterMember).toBe('interval.start_time')
    expect(dataTypeById('heart-rate')?.filterMember).toBe('sample_time.physical_time')
    expect(dataTypeById('daily-resting-heart-rate')?.filterMember).toBe('date')
    expect(dataTypeById('sleep')?.filterMember).toBe('interval.end_time')
    expect(dataTypeById('exercise')?.filterMember).toBe('interval.civil_start_time')
  })

  it('marks the two types that reject list entirely', () => {
    expect(dataTypeById('total-calories')?.listSupported).toBe(false)
    expect(dataTypeById('floors')?.listSupported).toBe(false)
  })

  it('gives every listable type a metric and a target', () => {
    for (const t of DATA_TYPES.filter((t) => t.listSupported)) {
      expect(t.metric, t.id).toBeTruthy()
      expect(['samples', 'sessions'], t.id).toContain(t.target)
    }
  })

  it('declares a scope for every type, so a missing grant is a known cause', () => {
    for (const t of DATA_TYPES) expect(t.scope, t.id).toMatch(/^googlehealth\./)
  })

  it('has no duplicate ids', () => {
    expect(new Set(DATA_TYPES.map((t) => t.id)).size).toBe(DATA_TYPES.length)
  })
})
