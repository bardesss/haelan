import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readSleepNights } from '../src/query/sleepNights.ts'
import { sessions, sessionSegments, sources } from '../src/db/schema/index.ts'

const H = 3_600_000
// 23:00 local on 2026-08-21 at +120 is 21:00Z, so the night starts before the date it belongs to.
const BEDTIME = Date.UTC(2026, 7, 21, 21, 0)

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  for (const id of ['watch', 'phone']) {
    test.db.insert(sources).values({
      id, personId: 'p1', externalId: id, displayName: id, kind: 'device', createdAtMs: 0,
    }).run()
  }
})
afterEach(() => test.cleanup())

const insertSession = (o: { id: string, startMs: number, endMs: number, localDate: string, sourceId?: string }) =>
  test.db.insert(sessions).values({
    id: o.id, personId: 'p1', sourceId: o.sourceId ?? 'watch', kind: 'sleep', externalId: o.id,
    startMs: o.startMs, startOffsetMinutes: 120, endMs: o.endMs, endOffsetMinutes: 120,
    localDate: o.localDate, attrs: JSON.stringify({ mainSleep: true }), rawPayloadId: null,
  }).run()

const insertSegment = (o: { id: string, sessionId: string, stage: string, startMs: number, endMs: number }) =>
  test.db.insert(sessionSegments).values(o).run()

describe('readSleepNights', () => {
  it('returns a night as one entry even when it arrived as three sessions', () => {
    insertSession({ id: 'a', startMs: BEDTIME, endMs: BEDTIME + 3 * H, localDate: '2026-08-22' })
    insertSession({ id: 'b', startMs: BEDTIME + 3 * H, endMs: BEDTIME + 6 * H, localDate: '2026-08-22' })
    insertSession({ id: 'c', startMs: BEDTIME + 6 * H, endMs: BEDTIME + 8 * H, localDate: '2026-08-22' })

    const nights = readSleepNights(test.db, { personId: 'p1', from: '2026-08-22', to: '2026-08-22' })
    expect(nights).toHaveLength(1)
    expect(nights[0]?.sessionIds.sort()).toEqual(['a', 'b', 'c'])
    expect(nights[0]?.startMs).toBe(BEDTIME)
    expect(nights[0]?.endMs).toBe(BEDTIME + 8 * H)
    // Not just "did not crash": a night with no segments reported is an empty list, not undefined
    // and not one manufactured from nothing.
    expect(nights[0]?.segments).toEqual([])
  })

  it('carries the stage segments in start order, which is what a hypnogram draws', () => {
    insertSession({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H, localDate: '2026-08-22' })
    // Inserted out of order deliberately: the reader orders, the caller does not.
    insertSegment({ id: 's2', sessionId: 'n', stage: 'DEEP', startMs: BEDTIME + 4 * H, endMs: BEDTIME + 6 * H })
    insertSegment({ id: 's1', sessionId: 'n', stage: 'LIGHT', startMs: BEDTIME, endMs: BEDTIME + 4 * H })

    const nights = readSleepNights(test.db, { personId: 'p1', from: '2026-08-22', to: '2026-08-22' })
    expect(nights[0]?.segments.map((s) => s.stage)).toEqual(['LIGHT', 'DEEP'])
  })

  // Parent spec invariant 3. The night above starts on the 21st and belongs to the 22nd, so a
  // range covering only the 21st must not return it.
  it('attributes a night crossing midnight to the date it ended on', () => {
    insertSession({ id: 'n', startMs: BEDTIME, endMs: BEDTIME + 8 * H, localDate: '2026-08-22' })
    expect(readSleepNights(test.db, { personId: 'p1', from: '2026-08-21', to: '2026-08-21' })).toEqual([])
    expect(readSleepNights(test.db, { personId: 'p1', from: '2026-08-22', to: '2026-08-22' })).toHaveLength(1)
  })

  it('returns nothing rather than throwing for a range with no sleep', () => {
    expect(readSleepNights(test.db, { personId: 'p1', from: '2026-08-01', to: '2026-08-03' })).toEqual([])
  })

  // Two devices can each report a full night for the same local date. Concatenating them into one
  // Night would duplicate segments and attribute one blended night to no device in particular.
  // Choosing between sources is the derive layer's job, not a reader's.
  it('keeps two sources reporting the same night as two nights, not one blended one', () => {
    insertSession({ id: 'n1', startMs: BEDTIME, endMs: BEDTIME + 8 * H, localDate: '2026-08-22', sourceId: 'watch' })
    insertSession({ id: 'n2', startMs: BEDTIME, endMs: BEDTIME + 8 * H, localDate: '2026-08-22', sourceId: 'phone' })

    const nights = readSleepNights(test.db, { personId: 'p1', from: '2026-08-22', to: '2026-08-22' })
    expect(nights).toHaveLength(2)
    expect(nights.map((n) => n.sourceId).sort()).toEqual(['phone', 'watch'])
  })

  it('filters to the requested source rather than every device reporting that night', () => {
    insertSession({ id: 'n1', startMs: BEDTIME, endMs: BEDTIME + 8 * H, localDate: '2026-08-22', sourceId: 'watch' })
    insertSession({ id: 'n2', startMs: BEDTIME, endMs: BEDTIME + 8 * H, localDate: '2026-08-22', sourceId: 'phone' })

    const nights = readSleepNights(test.db, {
      personId: 'p1', from: '2026-08-22', to: '2026-08-22', sourceId: 'watch',
    })
    expect(nights).toHaveLength(1)
    expect(nights[0]?.sourceId).toBe('watch')
  })
})
