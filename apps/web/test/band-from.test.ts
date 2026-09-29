import { describe, it, expect } from 'vitest'
import { bandFrom } from '../src/charts/bands.js'

describe('bandFrom', () => {
  it('is the centre plus and minus the spread', () => {
    expect(bandFrom({ center: 60, spread: 5, thin: false })).toEqual({ low: 55, high: 65 })
  })
  it('draws nothing for a thin baseline or none at all', () => {
    expect(bandFrom({ center: 60, spread: 5, thin: true })).toBeUndefined()
    expect(bandFrom(null)).toBeUndefined()
  })
})
