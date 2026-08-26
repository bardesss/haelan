import { describe, it, expect } from 'vitest'
import { emptyStateFor } from '../src/data/emptyState.js'
import type { SeriesPoint } from '../src/data/useSeries.js'

const point = (value: number | null, coverage: number | null): SeriesPoint =>
  ({ localDate: '2026-08-01', source: 'test', value: value ?? 0, coverage, sourceMix: null, updatedAtMs: null })

describe('emptyStateFor', () => {
  it('says nothing when there is real data', () => {
    expect(emptyStateFor([point(900, 0.9)])).toBeNull()
  })

  // The distinction the whole thing exists for. A zero is an answer: no naps were detected. A
  // null is the absence of an answer. Rendering them the same way throws away a distinction the
  // derivation is careful to keep.
  it('treats a real zero as data, not as emptiness', () => {
    expect(emptyStateFor([point(0, 0.9)])).toBeNull()
  })

  it('reports no data when the range returned no rows at all', () => {
    expect(emptyStateFor([])).toBe('no_data')
    expect(emptyStateFor(undefined)).toBe('no_data')
  })

  it('reports the device was not worn when rows exist but coverage is zero throughout', () => {
    expect(emptyStateFor([point(null, 0), point(null, 0)])).toBe('not_worn')
  })

  it('does not claim not worn when even one day has coverage', () => {
    expect(emptyStateFor([point(null, 0), point(900, 0.5)])).toBeNull()
  })

  // A baseline computed from three days looks exactly as authoritative as one from thirty. The
  // thin flag is the reader's only signal, so it has to reach them.
  it('reports insufficient data when the baseline is thin', () => {
    expect(emptyStateFor([point(900, 0.9)], { center: 900, spread: 10, n: 3, thin: true }))
      .toBe('insufficient')
  })

  it('says nothing when the baseline is present and not thin', () => {
    expect(emptyStateFor([point(900, 0.9)], { center: 900, spread: 10, n: 28, thin: false }))
      .toBeNull()
  })

  // An absent baseline is not the same as a thin one. A card that never asked for a baseline
  // must not be told its data is insufficient.
  it('says nothing when no baseline was requested', () => {
    expect(emptyStateFor([point(900, 0.9)], undefined)).toBeNull()
  })

  it('prefers the stronger statement when the range is empty and a baseline is thin', () => {
    expect(emptyStateFor([], { center: 0, spread: 0, n: 1, thin: true })).toBe('no_data')
  })
})
