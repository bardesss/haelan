import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readSleepNights } from '../src/query/sleepNights.ts'
import { sessions, sources } from '../src/db/schema/index.ts'
import { OverrideStore } from '../src/store/overrides.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { sessionTarget } from '../src/derive/targetKey.ts'

const H = 3_600_000
// 23:00 local on 2026-08-21 at +120 is 21:00Z, so the night starts before the date it belongs to.
const BEDTIME = Date.UTC(2026, 7, 21, 21, 0)

let test: TestDatabase
let overrides: OverrideStore

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({
    id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).run()
  overrides = new OverrideStore(test.db, new DeriveQueue(test.db))
})
afterEach(() => test.cleanup())

// Same helper shape sleep-nights.test.ts already seeds a night with, reused rather than
// reinvented: two DB rows on one local date, joined by assembleNights into a single night.
const insertSession = (o: { id: string, startMs: number, endMs: number, localDate: string }) =>
  test.db.insert(sessions).values({
    id: o.id, personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: o.id,
    startMs: o.startMs, startOffsetMinutes: 120, endMs: o.endMs, endOffsetMinutes: 120,
    localDate: o.localDate, rawPayloadId: null, attrs: JSON.stringify({ mainSleep: true }),
  }).run()

const read = () => readSleepNights(test.db, { personId: 'p1', from: '2026-08-22', to: '2026-08-22' })

describe('readSleepNights and overrides', () => {
  // The bug this task exists for: derivation drops an excluded session and the reader did not,
  // so the page drew a night the daily figures had already stopped believing in.
  it('assembles the night from the sessions derivation would have used', () => {
    // Two sleep sessions on one date; exclude the second.
    insertSession({ id: 'sleep-1', startMs: BEDTIME, endMs: BEDTIME + 4 * H, localDate: '2026-08-22' })
    insertSession({ id: 'sleep-2', startMs: BEDTIME + 4 * H, endMs: BEDTIME + 8 * H, localDate: '2026-08-22' })
    overrides.put({
      personId: 'p1', scope: 'session', targetKey: sessionTarget('sleep-2'),
      action: 'exclude', reason: 'strap came loose', nowMs: 1_000,
    })

    const [night] = read()
    // The night's endMs must match the first session's end, not the second's.
    expect(night!.endMs).toBe(BEDTIME + 4 * H)
    expect(night!.sessionIds).toEqual(['sleep-1'])
  })

  it('reports the excluded session rather than dropping it silently', () => {
    insertSession({ id: 'sleep-1', startMs: BEDTIME, endMs: BEDTIME + 4 * H, localDate: '2026-08-22' })
    insertSession({ id: 'sleep-2', startMs: BEDTIME + 4 * H, endMs: BEDTIME + 8 * H, localDate: '2026-08-22' })
    overrides.put({
      personId: 'p1', scope: 'session', targetKey: sessionTarget('sleep-2'),
      action: 'exclude', reason: 'strap came loose', nowMs: 1_000,
    })

    const [night] = read()
    expect(night!.excludedSessions).toEqual(['sleep-2'])
  })

  it('reports an empty list when nothing was excluded', () => {
    insertSession({ id: 'sleep-1', startMs: BEDTIME, endMs: BEDTIME + 4 * H, localDate: '2026-08-22' })
    insertSession({ id: 'sleep-2', startMs: BEDTIME + 4 * H, endMs: BEDTIME + 8 * H, localDate: '2026-08-22' })

    const [night] = read()
    expect(night!.excludedSessions).toEqual([])
  })

  // The same rule naps already follow: an empty array is a measurement, not an omission.
  it('does not apply another person\'s override', () => {
    insertSession({ id: 'sleep-1', startMs: BEDTIME, endMs: BEDTIME + 4 * H, localDate: '2026-08-22' })
    insertSession({ id: 'sleep-2', startMs: BEDTIME + 4 * H, endMs: BEDTIME + 8 * H, localDate: '2026-08-22' })
    seedPerson(test.db, 'p2')
    new OverrideStore(test.db, new DeriveQueue(test.db)).put({
      personId: 'p2', scope: 'session', targetKey: sessionTarget('sleep-2'),
      action: 'exclude', reason: 'theirs', nowMs: 1_000,
    })

    const [night] = read()
    expect(night!.excludedSessions).toEqual([])
    expect(night!.sessionIds).toEqual(['sleep-1', 'sleep-2'])
  })
})
