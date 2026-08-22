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
    expect(mapRollups({ dataType: totalCalories, body, personId: 'p1' })).toEqual({
      points: 1,
      readable: true,
      rows: [{
        personId: 'p1', localDate: '2026-08-21', metric: 'total_calories', agg: 'sum',
        source: 'provider', value: 2500.5, coverage: null, sourceMix: null,
        derivationVersion: DERIVATION_VERSION,
      }],
    })
  })

  it('casts an int64 that arrives as a string', () => {
    // floors.countSum is an int64, and Google serialises int64 as a JSON string. Left uncast it
    // is a string landing in a real column.
    const body = dailyRollupBody('floors', [
      { date: { year: 2026, month: 8, day: 21 }, value: { countSum: '56' } },
    ])
    const { rows } = mapRollups({ dataType: floors, body, personId: 'p1' })
    expect(rows[0]?.value).toBe(56)
    expect(typeof rows[0]?.value).toBe('number')
  })

  it('writes no row for a window the response omitted', () => {
    // Days with no data are absent from the array rather than zeroed. A zero here would be a
    // fabricated measurement, which is exactly what invariant 2 forbids.
    const body = dailyRollupBody('floors', [])
    expect(mapRollups({ dataType: floors, body, personId: 'p1' })).toEqual({ rows: [], points: 0, readable: true })
  })

  it('carries a null coverage, because there are no samples to measure', () => {
    const body = dailyRollupBody('totalCalories', [
      { date: { year: 2026, month: 8, day: 21 }, value: { kcalSum: 2500 } },
    ])
    expect(mapRollups({ dataType: totalCalories, body, personId: 'p1' }).rows[0]?.coverage).toBeNull()
  })

  it('survives a body that is not what it expected', () => {
    for (const body of ['not json', '{}', 'null', '{"rollupDataPoints":42}']) {
      const mapped = mapRollups({ dataType: floors, body, personId: 'p1' })
      expect(mapped.rows).toEqual([])
      expect(mapped.points).toBe(0)
    }
  })

  it('calls an empty object quiet and the rest unreadable', () => {
    // Surviving all four is not the same as understanding all four. `{}` is what proto3 JSON
    // emits for a window with no data, so it is an ordinary quiet answer. The other three are
    // shapes this code cannot read, and the walk must not move its cursor over them.
    expect(mapRollups({ dataType: floors, body: '{}', personId: 'p1' }).readable).toBe(true)
    for (const body of ['not json', 'null', '{"rollupDataPoints":42}']) {
      expect(mapRollups({ dataType: floors, body, personId: 'p1' }).readable).toBe(false)
    }
  })

  it('counts the points it saw even when it could map none of them, so the walk can tell the two apart', () => {
    // A day with no data is omitted from the response rather than zeroed, so no points is an
    // ordinary answer and points-but-no-rows is a body this mapper can no longer read. Only the
    // point count separates them, which is what runRollupJob's drift check reads.
    const renamed = dailyRollupBody('floors', [
      { date: { year: 2026, month: 8, day: 21 }, value: { countTotal: '56' } },
    ])
    expect(mapRollups({ dataType: floors, body: renamed, personId: 'p1' })).toEqual({ rows: [], points: 1, readable: true })
  })

  it('reports a body it could read, even when that body was empty', () => {
    const { readable } = mapRollups({ dataType: floors, body: dailyRollupBody('floors', []), personId: 'p1' })
    expect(readable).toBe(true)
  })

  it('reports a renamed envelope as unreadable rather than as a quiet day', () => {
    // The carried finding from the M2 design's section 7a. Google renaming rollupDataPoints
    // produced zero rows and zero points, which is precisely what a stretch of days with no
    // data produces, so the walk recorded an ordinary success and moved its cursor on.
    const body = JSON.stringify({ rollupDataPointList: [{ civilStartTime: { date: {} } }] })
    const mapped = mapRollups({ dataType: floors, body, personId: 'p1' })
    expect(mapped.readable).toBe(false)
    expect(mapped.rows).toEqual([])
  })

  it('reports a body that is not JSON as unreadable', () => {
    const mapped = mapRollups({ dataType: floors, body: '<html>502</html>', personId: 'p1' })
    expect(mapped.readable).toBe(false)
  })

})
