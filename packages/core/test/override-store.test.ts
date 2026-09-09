import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, insertSample, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { OverrideStore } from '../src/store/overrides.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { sampleTarget, sessionTarget, dayMetricTarget } from '../src/derive/targetKey.ts'
import { ConfigError } from '../src/errors.ts'
import { sessions, sources } from '../src/db/schema/index.ts'

const OFFSET = 120
const MIDNIGHT_UTC = Date.UTC(2026, 7, 21, 22, 0)
const NINE_AM = MIDNIGHT_UTC + 9 * 3_600_000
const LOCAL_DATE = '2026-08-22'
// Deliberately after 22:00 UTC so the +120 minute offset rolls it into the next UTC day: an
// implementation that read the day off raw UTC instead of the row's own offset would land on
// 2026-08-21 here and fail, where NINE_AM (same UTC and local day) would not have caught it.
const LATE_UTC = Date.UTC(2026, 7, 21, 23, 0)

let test: TestDatabase
let store: OverrideStore
let queue: DeriveQueue

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({
    id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).run()
  insertSample(test.db, {
    personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: NINE_AM,
    tzOffsetMinutes: OFFSET, value: 210,
  })
  queue = new DeriveQueue(test.db)
  store = new OverrideStore(test.db, queue)
})
afterEach(() => test.cleanup())

const excludeSample = () => store.put({
  personId: 'p1',
  scope: 'sample',
  targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: NINE_AM }),
  action: 'exclude',
  reason: 'strap glitch',
  nowMs: 1,
})

describe('OverrideStore', () => {
  it('stores an override and marks the day it lands on', () => {
    excludeSample()
    expect(store.listFor('p1')).toHaveLength(1)
    expect(queue.claim(10)).toEqual([{ personId: 'p1', localDate: LOCAL_DATE }])
  })

  it('marks the day again when the override is removed, so the original value comes back', () => {
    const id = excludeSample()
    queue.clear(queue.claim(10))
    store.remove({ personId: 'p1', id, nowMs: 2 })
    expect(store.listFor('p1')).toEqual([])
    expect(queue.claim(10)).toEqual([{ personId: 'p1', localDate: LOCAL_DATE }])
  })

  it('reads the day off the sample own offset, not off a guess', () => {
    // LATE_UTC falls after 22:00 UTC, so the +120 minute offset rolls it into the next UTC day.
    // Recomputing the day from the person timezone instead of the row's own offset is how a
    // night lands on the wrong side of a daylight saving change, and it would also fail here.
    insertSample(test.db, {
      personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs: LATE_UTC,
      tzOffsetMinutes: OFFSET,
    })
    store.put({
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'steps', utcMs: LATE_UTC }),
      action: 'exclude', reason: 'test', nowMs: 1,
    })
    expect(queue.claim(10)[0]?.localDate).toBe(LOCAL_DATE)
  })

  it('marks nothing when the targeted sample has not been synced yet', () => {
    // Not an error: the override can be written before a backfill reaches that day, and the sync
    // that writes the sample marks the day dirty on its own.
    store.put({
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'steps', utcMs: 5 }),
      action: 'exclude', reason: 'not here yet', nowMs: 1,
    })
    expect(queue.size()).toBe(0)
  })

  it('marks the session own local date', () => {
    test.db.insert(sessions).values({
      id: 'sess-1', personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: 'x',
      startMs: MIDNIGHT_UTC, startOffsetMinutes: OFFSET, endMs: NINE_AM, endOffsetMinutes: OFFSET,
      localDate: LOCAL_DATE, attrs: '{}', rawPayloadId: null,
    }).run()
    store.put({
      personId: 'p1', scope: 'session', targetKey: sessionTarget('sess-1'),
      action: 'exclude', reason: 'not asleep', nowMs: 1,
    })
    expect(queue.claim(10)).toEqual([{ personId: 'p1', localDate: LOCAL_DATE }])
  })

  it('marks the day a day_metric override names, without looking anything up', () => {
    store.put({
      personId: 'p1', scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: LOCAL_DATE, metric: 'steps' }),
      action: 'exclude', reason: 'phone in a tumble dryer', nowMs: 1,
    })
    expect(queue.claim(10)).toEqual([{ personId: 'p1', localDate: LOCAL_DATE }])
  })

  // The same resolution #markAffected marks with, which is why the write routes read it here
  // rather than working the day out again: a second copy could disagree with the day marked, and
  // the disagreement would show up as a correction reported against a day nobody derived.
  it('reports the day a target lands on, matching the day it marks', () => {
    test.db.insert(sessions).values({
      id: 'sess-1', personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: 'x',
      startMs: MIDNIGHT_UTC, startOffsetMinutes: OFFSET, endMs: NINE_AM, endOffsetMinutes: OFFSET,
      localDate: LOCAL_DATE, attrs: '{}', rawPayloadId: null,
    }).run()
    const sample = sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: NINE_AM })
    const reported = store.affectedLocalDate({ personId: 'p1', scope: 'sample', targetKey: sample })
    expect(reported).toBe(LOCAL_DATE)
    expect(store.affectedLocalDate({
      personId: 'p1', scope: 'session', targetKey: sessionTarget('sess-1'),
    })).toBe(LOCAL_DATE)
    expect(store.affectedLocalDate({
      personId: 'p1', scope: 'day_metric', targetKey: dayMetricTarget({ localDate: LOCAL_DATE, metric: 'steps' }),
    })).toBe(LOCAL_DATE)
    // The half the name promises: the day reported is the day put marks, compared here rather
    // than left resting on the two calls happening to share a private method today.
    excludeSample()
    expect(queue.claim(10)).toEqual([{ personId: 'p1', localDate: reported }])
    // Nothing marked and nothing to report: the sample is somebody else's, which is the same
    // answer a sample that has not been synced yet gets.
    expect(store.affectedLocalDate({ personId: 'p2', scope: 'sample', targetKey: sample })).toBeNull()
  })

  // The delete route reads one override by id before removing it, and an id is not a secret.
  it('reads one override by id, and nothing of another person by theirs', () => {
    const id = excludeSample()
    expect(store.get('p1', id)?.reason).toBe('strap glitch')
    expect(store.get('p1', 'no-such-id')).toBeNull()
    expect(store.get('p2', id)).toBeNull()
  })

  it('refuses to correct a whole day, because that number would have no source', () => {
    // A day level corrected value has no source, no aggregate to attach to when the metric
    // declares several, and nothing per source to be inspected against. Rejecting it is better
    // than storing something no derivation would ever apply.
    expect(() => store.put({
      personId: 'p1', scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: LOCAL_DATE, metric: 'steps' }),
      action: 'correct', correctedValue: 8000, reason: 'felt like more', nowMs: 1,
    })).toThrow(ConfigError)
  })

  it('refuses a correction with no value, and an exclusion that carries one', () => {
    const base = {
      personId: 'p1' as const, scope: 'sample' as const,
      targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: NINE_AM }),
      reason: 'r', nowMs: 1,
    }
    expect(() => store.put({ ...base, action: 'correct' })).toThrow(ConfigError)
    expect(() => store.put({ ...base, action: 'exclude', correctedValue: 5 })).toThrow(ConfigError)
  })

  it('refuses to correct a session, because one number cannot say which figure it means', () => {
    // A night derives asleep, awake, in bed, three stage totals, efficiency and two times. A
    // single corrected value names none of them, and setting asleep alone would leave the stage
    // totals no longer summing to it. Excluding the session still covers the real case.
    expect(() => store.put({
      personId: 'p1', scope: 'session', targetKey: sessionTarget('sess-1'),
      action: 'correct', correctedValue: 420, reason: 'felt shorter', nowMs: 1,
    })).toThrow(ConfigError)
  })

  it('refuses a target key that is not the shape its scope promises', () => {
    expect(() => store.put({
      personId: 'p1', scope: 'sample', targetKey: '{"session":"s"}',
      action: 'exclude', reason: 'r', nowMs: 1,
    })).toThrow(ConfigError)
  })

  it('refuses to remove another person override, even when the id is known', () => {
    // An override id is not a secret, and master design section 15 gives each account only its
    // own data with no sharing. M3 puts this id on the wire in a delete request, so scoping by
    // personId here is what stands between a guessed or leaked id and a cross-person deletion.
    seedPerson(test.db, 'p2')
    const id = excludeSample()
    queue.clear(queue.claim(10))
    store.remove({ personId: 'p2', id, nowMs: 2 })
    expect(store.listFor('p1')).toHaveLength(1)
    expect(queue.size()).toBe(0)
  })
})
