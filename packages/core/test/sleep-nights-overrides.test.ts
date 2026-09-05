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
// sourceId defaults to the one source every other test in this file seeds; the two-source test
// below is the only caller that passes a second one.
const insertSession = (o: { id: string, startMs: number, endMs: number, localDate: string, sourceId?: string }) =>
  test.db.insert(sessions).values({
    id: o.id, personId: 'p1', sourceId: o.sourceId ?? 'watch', kind: 'sleep', externalId: o.id,
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

  // Two devices reporting the same local date must not see each other's corrections: a night is
  // grouped by (localDate, sourceId), and excludedByDate is keyed the same way. Scoping by
  // localDate alone would still pass every test above it in this file, since they all seed a
  // single implicit source — this is the test that actually exercises the second key.
  it('reports only its own source\'s excluded session when two sources share a date', () => {
    test.db.insert(sources).values({
      id: 'ring', personId: 'p1', externalId: 'ring', displayName: 'ring', kind: 'device', createdAtMs: 0,
    }).run()

    insertSession({ id: 'watch-1', sourceId: 'watch', startMs: BEDTIME, endMs: BEDTIME + 4 * H, localDate: '2026-08-22' })
    insertSession({ id: 'watch-2', sourceId: 'watch', startMs: BEDTIME + 4 * H, endMs: BEDTIME + 8 * H, localDate: '2026-08-22' })
    insertSession({ id: 'ring-1', sourceId: 'ring', startMs: BEDTIME, endMs: BEDTIME + 5 * H, localDate: '2026-08-22' })
    insertSession({ id: 'ring-2', sourceId: 'ring', startMs: BEDTIME + 5 * H, endMs: BEDTIME + 9 * H, localDate: '2026-08-22' })
    overrides.put({
      personId: 'p1', scope: 'session', targetKey: sessionTarget('watch-2'),
      action: 'exclude', reason: 'strap came loose', nowMs: 1_000,
    })
    overrides.put({
      personId: 'p1', scope: 'session', targetKey: sessionTarget('ring-2'),
      action: 'exclude', reason: 'left charging', nowMs: 1_000,
    })

    const nights = read()
    const watchNight = nights.find((n) => n.sourceId === 'watch')
    const ringNight = nights.find((n) => n.sourceId === 'ring')
    expect(watchNight!.excludedSessions).toEqual(['watch-2'])
    expect(ringNight!.excludedSessions).toEqual(['ring-2'])
  })
})
