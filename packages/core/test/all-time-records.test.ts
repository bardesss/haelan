import { describe, it, expect } from 'vitest'
import { recordOf } from '../src/api/allTimeRecords.ts'

describe('recordOf', () => {
  it('answers the highest value and the day it was set', () => {
    expect(recordOf([
      { localDate: '2026-01-01', value: 10 },
      { localDate: '2026-01-02', value: 30 },
      { localDate: '2026-01-03', value: 20 },
    ])).toEqual({ localDate: '2026-01-02', value: 30 })
  })

  // Both orders, and the pair is the point. One alone passes by luck: handed the later day
  // first, a rule that always overwrites on equality still ends up on the earlier one, and a
  // mutation removing the date comparison entirely slipped through a single test of this.
  it('gives a tie to the earlier day when the later one came first', () => {
    expect(recordOf([
      { localDate: '2026-01-05', value: 30 },
      { localDate: '2026-01-02', value: 30 },
    ])).toEqual({ localDate: '2026-01-02', value: 30 })
  })

  it('gives a tie to the earlier day when the earlier one came first', () => {
    expect(recordOf([
      { localDate: '2026-01-02', value: 30 },
      { localDate: '2026-01-05', value: 30 },
    ])).toEqual({ localDate: '2026-01-02', value: 30 })
  })

  it('answers null for no days rather than a zero record', () => {
    // A zero would read as "your best day was nothing", which is a claim about the person
    // rather than about the archive having no rows.
    expect(recordOf([])).toBeNull()
  })

  it('keeps a negative best rather than treating zero as a floor', () => {
    // No metric on this page goes negative today, but a record function that silently floors at
    // zero is wrong in a way nobody would notice until one did.
    expect(recordOf([{ localDate: '2026-01-01', value: -5 }]))
      .toEqual({ localDate: '2026-01-01', value: -5 })
  })
})
