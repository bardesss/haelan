import { describe, it, expect } from 'vitest'
import { formatElapsed } from '../src/charts/elapsed.js'

describe('formatElapsed', () => {
  it('reads minutes and seconds under an hour, hours beyond', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(300_000)).toBe('5:00')
    expect(formatElapsed(28 * 60_000 + 4_000)).toBe('28:04')
    expect(formatElapsed(3_905_000)).toBe('1:05:05')
  })
})
