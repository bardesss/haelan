import { describe, it, expect } from 'vitest'
import { sessionForRecords, sessionRecordsOf } from '../src/api/sessionRecords.ts'
import type { SessionForRecords } from '../src/api/sessionRecords.ts'

const session = (over: Partial<SessionForRecords> = {}): SessionForRecords => ({
  sessionId: 's1', localDate: '2026-01-01', exerciseType: 'RUNNING',
  durationMs: 30 * 60_000, distanceMm: 5_000_000, kilometreSeconds: [],
  efforts: { km: null, mile: null, fiveK: null },
  ...over,
})

describe('sessionRecordsOf', () => {
  it('finds the longest session by the clock', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'a', durationMs: 30 * 60_000 }),
      session({ sessionId: 'b', durationMs: 264 * 60_000, localDate: '2026-06-19', exerciseType: 'CARDIO_WORKOUT' }),
    ])
    expect(records.find((r) => r.kind === 'longest')).toEqual({
      kind: 'longest', sessionId: 'b', localDate: '2026-06-19',
      exerciseType: 'CARDIO_WORKOUT', value: 264 * 60_000,
    })
  })

  it('finds the furthest session, ignoring one that recorded no distance', () => {
    // Most sessions carry no distance at all - a gym session has none - and a null must not
    // read as a zero that competes.
    const records = sessionRecordsOf([
      session({ sessionId: 'a', distanceMm: null }),
      session({ sessionId: 'b', distanceMm: 12_850_000, localDate: '2026-09-12' }),
    ])
    expect(records.find((r) => r.kind === 'furthest')).toMatchObject({
      sessionId: 'b', value: 12_850_000,
    })
  })

  it('finds the fastest kilometre across every session that split into them', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'a', kilometreSeconds: [372, 365] }),
      session({ sessionId: 'b', kilometreSeconds: [308], localDate: '2026-06-16' }),
    ])
    expect(records.find((r) => r.kind === 'fastest-km')).toMatchObject({
      sessionId: 'b', localDate: '2026-06-16', value: 308,
    })
  })

  it('gives a tie to the earlier session, as a daily record does', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'late', localDate: '2026-05-05', durationMs: 60 * 60_000 }),
      session({ sessionId: 'early', localDate: '2026-02-02', durationMs: 60 * 60_000 }),
    ])
    expect(records.find((r) => r.kind === 'longest')?.sessionId).toBe('early')
  })

  it('answers nothing at all rather than zeros when there are no sessions', () => {
    expect(sessionRecordsOf([])).toEqual([])
  })

  it('omits a record no session supports, and keeps the ones they do', () => {
    // A household that only ever does gym sessions has a longest workout and neither of the
    // other two. Three cards, one of which says "no distance ever recorded", would be worse
    // than two cards.
    const records = sessionRecordsOf([session({ distanceMm: null, kilometreSeconds: [] })])
    expect(records.map((r) => r.kind)).toEqual(['longest'])
  })

  it('takes the fastest kilometre as the quicker of the splits and the GPS, whichever is lower', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'splits', kilometreSeconds: [300], efforts: { km: 310, mile: null, fiveK: null } }),
      session({ sessionId: 'gps', kilometreSeconds: [305], efforts: { km: 295, mile: null, fiveK: null } }),
    ])
    expect(records.find((r) => r.kind === 'fastest-km')).toMatchObject({ sessionId: 'gps', value: 295 })
    // The splits win when they are the quicker, and a session with GPS alone still competes.
    expect(sessionRecordsOf([
      session({ sessionId: 'splits', kilometreSeconds: [290], efforts: { km: 310, mile: null, fiveK: null } }),
      session({ sessionId: 'gps-only', kilometreSeconds: [], efforts: { km: 292, mile: null, fiveK: null } }),
    ]).find((r) => r.kind === 'fastest-km')).toMatchObject({ sessionId: 'splits', value: 290 })
    expect(sessionRecordsOf([session({ sessionId: 'gps-only', efforts: { km: 292, mile: null, fiveK: null } })])
      .find((r) => r.kind === 'fastest-km')).toMatchObject({ sessionId: 'gps-only', value: 292 })
  })

  it('finds the fastest mile and 5 km from the GPS, omitting each no route covered', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'a', localDate: '2026-02-01', efforts: { km: 300, mile: 490, fiveK: 1600 } }),
      session({ sessionId: 'b', localDate: '2026-03-01', efforts: { km: 310, mile: 480, fiveK: null } }),
    ])
    expect(records.find((r) => r.kind === 'fastest-mile')).toMatchObject({ sessionId: 'b', value: 480 })
    expect(records.find((r) => r.kind === 'fastest-5k')).toMatchObject({ sessionId: 'a', value: 1600 })
    expect(sessionRecordsOf([session({ efforts: { km: 300, mile: null, fiveK: null } })]).map((r) => r.kind))
      .toEqual(['longest', 'furthest', 'fastest-km'])
  })
})

describe('sessionForRecords', () => {
  const START = Date.parse('2026-09-01T07:00:00Z')
  const row = { id: 's1', localDate: '2026-09-01', startMs: START, endMs: START + 30 * 60_000, attrs: { exerciseType: 'RUNNING' } }
  const metresPerDegree = (6_371_000 * Math.PI) / 180

  it('reads the efforts off the route, and nulls without one', () => {
    // 1.2 km due north at 4 m/s, a fix every 10 s.
    const route = Array.from({ length: 31 }, (_, i) => ({
      atMs: START + i * 10_000, latitude: 52 + (i * 40) / metresPerDegree, longitude: 5,
      altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
    }))
    const withRoute = sessionForRecords(row, route)
    expect(withRoute.efforts.km).toBeCloseTo(250, 6)
    expect([withRoute.efforts.mile, withRoute.efforts.fiveK]).toEqual([null, null])
    expect(sessionForRecords(row).efforts).toEqual({ km: null, mile: null, fiveK: null })
  })
})
