import { describe, it, expect } from 'vitest'
import { sessionRecordsOf } from '../src/api/sessionRecords.ts'
import type { SessionForRecords } from '../src/api/sessionRecords.ts'

const session = (over: Partial<SessionForRecords> = {}): SessionForRecords => ({
  sessionId: 's1', localDate: '2026-01-01', exerciseType: 'RUNNING',
  durationMs: 30 * 60_000, distanceMm: 5_000_000, kilometreSeconds: [],
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
})
