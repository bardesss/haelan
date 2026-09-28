import { describe, expect, it } from 'vitest'
import { MAX_PRESETS, SEED_KINDS, validatePresets } from '../src/api/eventKinds.ts'

describe('validatePresets', () => {
  it('trims and keeps order', () => {
    expect(validatePresets(['  alcohol ', 'sauna'])).toEqual(['alcohol', 'sauna'])
  })
  it('allows an empty list', () => {
    expect(validatePresets([])).toEqual([])
  })
  it('refuses a non-array, a non-string and an empty kind', () => {
    expect(() => validatePresets('alcohol')).toThrow(/kinds must be an array/)
    expect(() => validatePresets([3])).toThrow(/kind 1 must be text/)
    expect(() => validatePresets(['  '])).toThrow(/kind 1 is empty/)
  })
  it('refuses a kind over 40 characters', () => {
    expect(() => validatePresets(['x'.repeat(41)])).toThrow(/kind 1 is longer than 40/)
    expect(validatePresets(['x'.repeat(40)])).toHaveLength(1)
  })
  it('refuses a case-insensitive duplicate', () => {
    expect(() => validatePresets(['Alcohol', 'alcohol '])).toThrow(/kind 2 repeats "alcohol"/)
  })
  it('refuses more than 16', () => {
    const many = Array.from({ length: MAX_PRESETS + 1 }, (_, i) => `k${i}`)
    expect(() => validatePresets(many)).toThrow(/at most 16/)
    expect(validatePresets(many.slice(0, MAX_PRESETS))).toHaveLength(MAX_PRESETS)
  })
  it('seeds the eleven kinds in order', () => {
    expect(SEED_KINDS).toEqual([
      'illness', 'travel', 'alcohol', 'medication', 'injury', 'caffeine',
      'meditation', 'sauna', 'reading', 'screen_free', 'stretching',
    ])
  })
})
