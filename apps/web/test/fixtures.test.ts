import { describe, it, expect } from 'vitest'
import { july } from '../src/fixtures/july.js'

describe('july fixtures', () => {
  it('covers a full month', () => {
    expect(july.days).toHaveLength(31)
  })

  // Gap days must be null rather than zero so the UI can tell absence from a real zero.
  it('marks unworn days as null rather than zero', () => {
    const unworn = july.days.filter((d) => !d.worn)
    expect(unworn.length).toBeGreaterThan(0)
    for (const day of unworn) {
      expect(day.steps).toBeNull()
      expect(day.hrMean).toBeNull()
    }
  })

  it('is deterministic across imports', async () => {
    const again = (await import('../src/fixtures/july.js')).july
    expect(again.days).toEqual(july.days)
  })

  it('provides one night of stages and a month of schedule spans', () => {
    expect(july.hypnogram.length).toBeGreaterThan(10)
    expect(july.schedule).toHaveLength(31)
  })
})
