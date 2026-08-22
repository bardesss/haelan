import { describe, expect, it } from 'vitest'
import { dataTypeById } from '../src/api/catalogue.ts'
import { mapRollups } from '../src/api/mapRollups.ts'
import { dailyRollupBody } from '../src/testing/payloads.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'

const totalCalories = dataTypeById('total-calories')!
const floors = dataTypeById('floors')!

describe('mapRollups', () => {
  it('maps a civil window to the local date it covers', () => {
    const body = dailyRollupBody('totalCalories', [
      { date: { year: 2026, month: 8, day: 21 }, value: { kcalSum: 2500.5 } },
    ])
    expect(mapRollups({ dataType: totalCalories, body, personId: 'p1' })).toEqual([{
      personId: 'p1', localDate: '2026-08-21', metric: 'total_calories', agg: 'sum',
      source: 'provider', value: 2500.5, coverage: null, derivationVersion: DERIVATION_VERSION,
    }])
  })

  it('casts an int64 that arrives as a string', () => {
    // floors.countSum is an int64, and Google serialises int64 as a JSON string. Left uncast it
    // is a string landing in a real column.
    const body = dailyRollupBody('floors', [
      { date: { year: 2026, month: 8, day: 21 }, value: { countSum: '56' } },
    ])
    const rows = mapRollups({ dataType: floors, body, personId: 'p1' })
    expect(rows[0]?.value).toBe(56)
    expect(typeof rows[0]?.value).toBe('number')
  })

  it('writes no row for a window the response omitted', () => {
    // Days with no data are absent from the array rather than zeroed. A zero here would be a
    // fabricated measurement, which is exactly what invariant 2 forbids.
    const body = dailyRollupBody('floors', [])
    expect(mapRollups({ dataType: floors, body, personId: 'p1' })).toEqual([])
  })

  it('carries a null coverage, because there are no samples to measure', () => {
    const body = dailyRollupBody('totalCalories', [
      { date: { year: 2026, month: 8, day: 21 }, value: { kcalSum: 2500 } },
    ])
    expect(mapRollups({ dataType: totalCalories, body, personId: 'p1' })[0]?.coverage).toBeNull()
  })

  it('survives a body that is not what it expected', () => {
    for (const body of ['not json', '{}', 'null', '{"rollupDataPoints":42}']) {
      expect(mapRollups({ dataType: floors, body, personId: 'p1' })).toEqual([])
    }
  })
})
