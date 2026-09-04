import { describe, it, expect } from 'vitest'
import { emptyStateFor, wornOn, coverageIsWearSignal, NOT_WORN_MAX_COVERAGE } from '../src/data/emptyState.js'
import type { SeriesPoint } from '../src/data/useSeries.js'

const point = (value: number | null, coverage: number | null): SeriesPoint =>
  ({ localDate: '2026-08-01', source: 'test', value: value ?? 0, coverage, sourceMix: null, updatedAtMs: null })

// A continuously sampled metric, so its coverage is a statement about wear.
const WORN = 'steps'

describe('coverageIsWearSignal', () => {
  it('says yes only for the continuously sampled metrics', () => {
    expect(coverageIsWearSignal('steps')).toBe(true)
    expect(coverageIsWearSignal('heart_rate')).toBe(true)
    // Once a day by nature: a perfect resting heart rate reads 1/24, which is a full day rather
    // than an hour of one.
    expect(coverageIsWearSignal('resting_heart_rate')).toBe(false)
    expect(coverageIsWearSignal('sleep_asleep_minutes')).toBe(false)
    // Their coverage measures how ACTIVE the day was, not how much of it was observed.
    expect(coverageIsWearSignal('active_minutes_light')).toBe(false)
  })
})

describe('wornOn', () => {
  it('answers null rather than false for a row that carries no coverage', () => {
    expect(wornOn(WORN, point(900, null))).toBeNull()
  })

  it('answers null for a metric whose coverage is not about wear', () => {
    expect(wornOn('resting_heart_rate', point(60, 1 / 24))).toBeNull()
    expect(wornOn('sleep_asleep_minutes', point(420, null))).toBeNull()
  })

  it('reads the single hour a derivation can least report as not worn', () => {
    // coverageOf is hours.size / 24 over rows that exist only because a sample fed them, so this
    // is the smallest coverage the derivation can write. Zero is not one of its outputs.
    expect(wornOn(WORN, point(10, NOT_WORN_MAX_COVERAGE))).toBe(false)
    expect(wornOn(WORN, point(900, 2 / 24))).toBe(true)
  })
})

describe('emptyStateFor', () => {
  it('says nothing when there is real data', () => {
    expect(emptyStateFor(WORN, [point(900, 0.9)])).toBeNull()
  })

  // The distinction the whole thing exists for. A zero is an answer: no naps were detected. A
  // null is the absence of an answer. Rendering them the same way throws away a distinction the
  // derivation is careful to keep.
  it('treats a real zero as data, not as emptiness', () => {
    expect(emptyStateFor(WORN, [point(0, 0.9)])).toBeNull()
  })

  it('reports no data when the range returned no rows at all', () => {
    expect(emptyStateFor(WORN, [])).toBe('no_data')
    expect(emptyStateFor(WORN, undefined)).toBe('no_data')
  })

  it('reports the device was not worn when every day that can answer says so', () => {
    expect(emptyStateFor(WORN, [point(null, 1 / 24), point(null, 1 / 24)])).toBe('not_worn')
  })

  it('does not claim not worn when even one day was worn', () => {
    expect(emptyStateFor(WORN, [point(null, 1 / 24), point(900, 0.5)])).toBeNull()
  })

  // The Critical this file did not catch. Every sleep row the derivation writes carries
  // coverage: null on purpose, so reading a null as a zero rendered "Device not worn" over a
  // fully populated month and never drew the mean at all.
  it('never claims not worn from rows whose coverage is null', () => {
    expect(emptyStateFor('sleep_asleep_minutes', [point(420, null), point(430, null)])).toBeNull()
  })

  // A resting heart rate's rows do carry a coverage, and it is 1/24 every single day. Judging it
  // against a wear threshold is the same defect entering by the other door.
  it('never claims not worn for a metric whose coverage is not about wear', () => {
    expect(emptyStateFor('resting_heart_rate', [point(58, 1 / 24), point(60, 1 / 24)])).toBeNull()
  })

})
