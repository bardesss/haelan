import { describe, it, expect } from 'vitest'
import { canonicalUrl } from '../src/demo/canonicalUrl.js'

describe('canonicalUrl', () => {
  it('leaves a bare path alone', () => {
    expect(canonicalUrl('/api/v1/p/demo/data-types')).toBe('/api/v1/p/demo/data-types')
  })

  it('drops an empty query string', () => {
    expect(canonicalUrl('/api/v1/p/demo/sources?')).toBe('/api/v1/p/demo/sources')
  })

  it('sorts parameters by key', () => {
    expect(canonicalUrl('/x?to=2026-09-07&from=2026-09-01&agg=sum'))
      .toBe('/x?agg=sum&from=2026-09-01&to=2026-09-07')
  })

  it('sorts repeated values of one key, because every repeated parameter here is a set', () => {
    expect(canonicalUrl('/x?metric=steps&metric=calories&metric=distance'))
      .toBe('/x?metric=calories&metric=distance&metric=steps')
  })

  it('gives two spellings of one question the same answer', () => {
    const a = canonicalUrl('/x?metric=steps&metric=calories&from=2026-09-01')
    const b = canonicalUrl('/x?from=2026-09-01&metric=calories&metric=steps')
    expect(a).toBe(b)
  })

  it('preserves a value that only differs by case or encoding', () => {
    // Two different questions, not one: a source id is opaque and case matters.
    expect(canonicalUrl('/x?source=AB12')).not.toBe(canonicalUrl('/x?source=ab12'))
  })
})
