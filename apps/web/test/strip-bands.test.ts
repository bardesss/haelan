import { describe, it, expect } from 'vitest'
import { stripBands } from '../src/pages/dashboard/cardShared.js'
import type { GlanceStripDay } from '../src/data/useGlance.js'

const day = (localDate: string, band: GlanceStripDay['band']): GlanceStripDay => ({ localDate, value: 1, band, standing: null })

describe('stripBands', () => {
  it('hands each day its own low and high, and null for a day with no band or only a thin one', () => {
    expect(stripBands([
      day('2026-09-01', { center: 8, low: 6, high: 10, thin: false }),
      day('2026-09-02', null),
      day('2026-09-03', { center: 9, low: 7, high: 11, thin: true }),
      day('2026-09-04', { center: 9, low: 7.5, high: 10.5, thin: false }),
    ])).toEqual([{ low: 6, high: 10 }, null, null, { low: 7.5, high: 10.5 }])
  })

  it('is undefined when no day has a band to shade, so the strip draws no band series at all', () => {
    expect(stripBands([day('2026-09-01', null), day('2026-09-02', { center: 9, low: 7, high: 11, thin: true })])).toBeUndefined()
  })
})
