import { describe, it, expect } from 'vitest'
import { RECORD_KINDS_BY_CATEGORY, sessionForRecords, sessionRecordsOf } from '../src/api/sessionRecords.ts'
import type { SessionForRecords } from '../src/api/sessionRecords.ts'

const session = (over: Partial<SessionForRecords> = {}): SessionForRecords => ({
  sessionId: 's1', localDate: '2026-01-01', exerciseType: 'RUNNING',
  durationMs: 30 * 60_000, distanceMm: 5_000_000, elevationGainMeters: null, kilometreSeconds: [],
  efforts: {},
  ...over,
})

describe('sessionRecordsOf', () => {
  it('finds the longest session by the clock', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'a', durationMs: 30 * 60_000 }),
      session({ sessionId: 'b', durationMs: 264 * 60_000, localDate: '2026-06-19', exerciseType: 'CARDIO_WORKOUT' }),
    ])
    expect(records.find((r) => r.kind === 'longest' && r.category === 'cardio')).toEqual({
      category: 'cardio', kind: 'longest', sessionId: 'b', localDate: '2026-06-19',
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
      // Whole metres.
      sessionId: 'b', value: 12_850,
    })
  })

  it('finds the fastest kilometre across every session that split into them', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'a', kilometreSeconds: [372, 365] }),
      session({ sessionId: 'b', kilometreSeconds: [308], localDate: '2026-06-16' }),
    ])
    expect(records.find((r) => r.kind === 'fastest-1k')).toMatchObject({
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
      session({ sessionId: 'splits', kilometreSeconds: [300], efforts: { '1k': 310 } }),
      session({ sessionId: 'gps', kilometreSeconds: [305], efforts: { '1k': 295 } }),
    ])
    expect(records.find((r) => r.kind === 'fastest-1k')).toMatchObject({ sessionId: 'gps', value: 295 })
    // The splits win when they are the quicker, and a session with GPS alone still competes.
    expect(sessionRecordsOf([
      session({ sessionId: 'splits', kilometreSeconds: [290], efforts: { '1k': 310 } }),
      session({ sessionId: 'gps-only', kilometreSeconds: [], efforts: { '1k': 292 } }),
    ]).find((r) => r.kind === 'fastest-1k')).toMatchObject({ sessionId: 'splits', value: 290 })
    expect(sessionRecordsOf([session({ sessionId: 'gps-only', efforts: { '1k': 292 } })])
      .find((r) => r.kind === 'fastest-1k')).toMatchObject({ sessionId: 'gps-only', value: 292 })
  })

  it('finds the fastest mile and 5 km from the GPS, omitting each no route covered', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'a', localDate: '2026-02-01', efforts: { '1k': 300, mile: 490, '5k': 1600 } }),
      session({ sessionId: 'b', localDate: '2026-03-01', efforts: { '1k': 310, mile: 480, '5k': null } }),
    ])
    expect(records.find((r) => r.kind === 'fastest-mile')).toMatchObject({ sessionId: 'b', value: 480 })
    expect(records.find((r) => r.kind === 'fastest-5k')).toMatchObject({ sessionId: 'a', value: 1600 })
    expect(sessionRecordsOf([session({ efforts: { '1k': 300, mile: null, '5k': null } })]).map((r) => r.kind))
      .toEqual(['longest', 'furthest', 'fastest-1k'])
  })

  it('picks the fastest holders in whole seconds, so a tie on screen goes to the earlier run', () => {
    // Both print 4:01 (and 8:01, 25:01); fractional, the later run would take all three.
    const records = sessionRecordsOf([
      session({ sessionId: 'early', localDate: '2026-02-01', efforts: { '1k': 241.4, mile: 481.4, '5k': 1501.4 } }),
      session({ sessionId: 'late', localDate: '2026-03-01', efforts: { '1k': 241.2, mile: 481.2, '5k': 1501.2 } }),
    ])
    expect(records.find((r) => r.kind === 'fastest-1k')).toMatchObject({ sessionId: 'early', value: 241 })
    expect(records.find((r) => r.kind === 'fastest-mile')).toMatchObject({ sessionId: 'early', value: 481 })
    expect(records.find((r) => r.kind === 'fastest-5k')).toMatchObject({ sessionId: 'early', value: 1501 })
  })
})

describe('sessionRecordsOf, per category', () => {
  const kinds = (records: ReturnType<typeof sessionRecordsOf>) => records.map((r) => `${r.category}:${r.kind}:${r.sessionId}`)

  it('keeps each category its own records: a ride holds no run record', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'run', distanceMm: 5_000_000, durationMs: 30 * 60_000 }),
      session({ sessionId: 'ride', exerciseType: 'BIKING', distanceMm: 60_000_000, durationMs: 180 * 60_000 }),
    ])
    expect(kinds(records)).toEqual([
      'run:longest:run', 'run:furthest:run',
      'ride:longest:ride', 'ride:furthest:ride',
    ])
  })

  it("never lets a ride's kilometre split make a fastest kilometre, in either category", () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'ride', exerciseType: 'BIKING', kilometreSeconds: [90] }),
    ])
    expect(records.filter((r) => r.kind.startsWith('fastest-'))).toEqual([])
  })

  it('counts a trail run, an incline run and a track run as runs', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'road', localDate: '2026-01-01', distanceMm: 5_000_000, kilometreSeconds: [300] }),
      session({ sessionId: 'trail', localDate: '2026-02-01', exerciseType: 'TRAIL_RUN', distanceMm: 21_000_000 }),
      session({ sessionId: 'incline', localDate: '2026-03-01', exerciseType: 'INCLINE_RUN', kilometreSeconds: [280] }),
      session({ sessionId: 'track', localDate: '2026-04-01', exerciseType: 'TRACK_AND_FIELD', durationMs: 120 * 60_000 }),
    ])
    expect(records.every((r) => r.category === 'run')).toBe(true)
    expect(records.find((r) => r.kind === 'furthest')?.sessionId).toBe('trail')
    expect(records.find((r) => r.kind === 'fastest-1k')?.sessionId).toBe('incline')
    expect(records.find((r) => r.kind === 'longest')?.sessionId).toBe('track')
  })

  it('counts a treadmill run toward the longest run only', () => {
    const records = sessionRecordsOf([
      session({
        sessionId: 'treadmill', exerciseType: 'TREADMILL', durationMs: 90 * 60_000, distanceMm: 15_000_000,
        elevationGainMeters: 200, kilometreSeconds: [200], efforts: { '1k': 200, '5k': 1000 },
      }),
    ])
    expect(kinds(records)).toEqual(['run:longest:treadmill'])
  })

  it('counts an indoor or electric ride toward the longest ride only', () => {
    for (const exerciseType of ['STATIONARY_BIKE', 'SPINNING', 'ASSAULT_BIKE', 'ELECTRIC_BIKE']) {
      const records = sessionRecordsOf([session({ exerciseType, distanceMm: 30_000_000, elevationGainMeters: 50, efforts: { '20k': 1800 } })])
      expect(kinds(records)).toEqual(['ride:longest:s1'])
    }
  })

  it("reads a ride's fastest distances off its GPS alone", () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'a', exerciseType: 'OUTDOOR_BIKE', localDate: '2026-02-01', efforts: { '20k': 2400.4, '40k': 5000, '100k': null } }),
      session({ sessionId: 'b', exerciseType: 'MOUNTAIN_BIKE', localDate: '2026-03-01', efforts: { '20k': 2300, '40k': null, '100k': null } }),
    ])
    expect(records.find((r) => r.kind === 'fastest-20k')).toMatchObject({ category: 'ride', sessionId: 'b', value: 2300 })
    expect(records.find((r) => r.kind === 'fastest-40k')).toMatchObject({ sessionId: 'a', value: 5000 })
    expect(records.find((r) => r.kind === 'fastest-100k')).toBeUndefined()
  })

  it('keeps longest and furthest for a swim, and nothing else', () => {
    const records = sessionRecordsOf([
      session({ exerciseType: 'SWIMMING_POOL', distanceMm: 1_500_000, elevationGainMeters: 3, kilometreSeconds: [900], efforts: { '1k': 900 } }),
    ])
    expect(kinds(records)).toEqual(['swim:longest:s1', 'swim:furthest:s1'])
  })

  it('keeps only the longest session for strength, cardio and other', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'lift', exerciseType: 'WEIGHTLIFTING', elevationGainMeters: 10 }),
      session({ sessionId: 'hiit', exerciseType: 'HIIT' }),
      session({ sessionId: 'chess', exerciseType: 'UNDERWATER_CHESS' }),
      session({ sessionId: 'none', exerciseType: null, localDate: '2025-01-01' }),
    ])
    expect(kinds(records)).toEqual(['strength:longest:lift', 'cardio:longest:hiit', 'other:longest:none'])
  })

  it('finds the most climb in whole metres, for the types that count toward distance records', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'hill', localDate: '2026-02-01', elevationGainMeters: 412.4 }),
      session({ sessionId: 'later', localDate: '2026-03-01', elevationGainMeters: 411.6 }),
      session({ sessionId: 'flat', elevationGainMeters: 0 }),
      session({ sessionId: 'hike', exerciseType: 'HIKING', elevationGainMeters: 900 }),
    ])
    // 412.4 and 411.6 both print 412 m, so the earlier run keeps it.
    expect(records.find((r) => r.category === 'run' && r.kind === 'most-climb')).toMatchObject({ sessionId: 'hill', value: 412 })
    expect(records.find((r) => r.category === 'walk' && r.kind === 'most-climb')).toMatchObject({ sessionId: 'hike', value: 900 })
  })

  it('picks the longest in whole seconds, so a tie on screen goes to the earlier session', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'late', localDate: '2026-05-01', durationMs: 3_600_400 }),
      session({ sessionId: 'early', localDate: '2026-02-01', durationMs: 3_599_600 }),
    ])
    expect(records.find((r) => r.kind === 'longest')).toMatchObject({ sessionId: 'early', value: 3_600_000 })
  })

  it('holds no climb that rounds to nothing', () => {
    expect(sessionRecordsOf([session({ elevationGainMeters: 0.4 })]).map((r) => r.kind)).toEqual(['longest', 'furthest'])
  })

  it('picks the furthest in whole metres, so a tie on screen goes to the earlier session', () => {
    const records = sessionRecordsOf([
      session({ sessionId: 'late', localDate: '2026-05-01', distanceMm: 10_000_400 }),
      session({ sessionId: 'early', localDate: '2026-02-01', distanceMm: 9_999_600 }),
    ])
    expect(records.find((r) => r.kind === 'furthest')).toMatchObject({ sessionId: 'early', value: 10_000 })
  })

  it("names each category's kinds, in the order a page lists them", () => {
    expect(RECORD_KINDS_BY_CATEGORY).toEqual({
      run: ['longest', 'furthest', 'most-climb', 'fastest-1k', 'fastest-mile', 'fastest-5k', 'fastest-10k', 'fastest-half', 'fastest-marathon'],
      ride: ['longest', 'furthest', 'most-climb', 'fastest-20k', 'fastest-40k', 'fastest-100k'],
      walk: ['longest', 'furthest', 'most-climb'],
      swim: ['longest', 'furthest'],
      strength: ['longest'],
      cardio: ['longest'],
      other: ['longest'],
    })
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
    expect(withRoute.efforts['1k']).toBeCloseTo(250, 6)
    expect([withRoute.efforts['mile'], withRoute.efforts['5k']]).toEqual([null, null])
    expect(sessionForRecords(row).efforts).toEqual({})
    // A ride's route is read over the ride's own distances, none of which 1.2 km covers.
    const ride = sessionForRecords({ ...row, attrs: { exerciseType: 'BIKING' } }, route)
    expect(ride.efforts).toEqual({ '20k': null, '40k': null, '100k': null })
    // A walk reads no efforts at all.
    expect(sessionForRecords({ ...row, attrs: { exerciseType: 'WALKING' } }, route).efforts).toEqual({})
  })

  it('reads the climb off the metrics summary, in metres, and null for none or zero', () => {
    const climb = (metricsSummary: unknown) => sessionForRecords({ ...row, attrs: { exerciseType: 'RUNNING', metricsSummary } }).elevationGainMeters
    expect(climb({ elevationGainMillimeters: 123_400 })).toBe(123.4)
    expect(climb({ elevationGainMillimeters: 0 })).toBeNull()
    expect(climb({})).toBeNull()
    expect(climb(null)).toBeNull()
  })
})
