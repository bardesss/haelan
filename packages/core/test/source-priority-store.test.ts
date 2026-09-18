import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, insertSample, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { SourcePriorityStore } from '../src/store/sourcePriority.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { UNRANKED_BASE, DEFAULT_LIST } from '../src/derive/priority.ts'
import { ConfigError } from '../src/errors.ts'
import { sources, sessions, deriveQueue as deriveQueueTable } from '../src/db/schema/index.ts'

const OFFSET = 120
const MIDNIGHT_UTC = Date.UTC(2026, 7, 21, 22, 0)

let test: TestDatabase
let store: SourcePriorityStore
let queue: DeriveQueue

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  seedPerson(test.db, 'p2')
  test.db.insert(sources).values([
    { id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0 },
    { id: 'phone', personId: 'p1', externalId: 'phone', displayName: 'phone', kind: 'app', createdAtMs: 0 },
    { id: 'their-watch', personId: 'p2', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0 },
  ]).run()
  queue = new DeriveQueue(test.db)
  store = new SourcePriorityStore(test.db, queue)
})
afterEach(() => test.cleanup())

const insertAtHour = (hour: number) =>
  insertSample(test.db, {
    personId: 'p1', sourceId: 'watch', metric: 'steps',
    utcMs: MIDNIGHT_UTC + hour * 3_600_000, tzOffsetMinutes: OFFSET,
  })

const insertAt = (utcMs: number, tzOffsetMinutes: number) =>
  insertSample(test.db, {
    personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs, tzOffsetMinutes,
  })

const markedDates = () => queue.claim(100).map((entry) => entry.localDate)

describe('SourcePriorityStore', () => {
  it('loads the kind fallback when nothing is configured', () => {
    const priority = store.load('p1')
    expect(priority.rank('steps', 'watch')).toBeGreaterThanOrEqual(UNRANKED_BASE)
    expect(priority.rank('steps', 'watch')).toBeLessThan(priority.rank('steps', 'phone'))
  })

  it('round trips a list', () => {
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone', 'watch'], nowMs: 1 })
    expect(store.load('p1').rank('steps', 'phone')).toBe(0)
    expect(store.lists('p1')).toEqual([{ metric: 'steps', sourceIds: ['phone', 'watch'] }])
  })

  it('replaces a list rather than appending to it, so ranks stay dense', () => {
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone', 'watch'], nowMs: 1 })
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['watch'], nowMs: 2 })
    expect(store.lists('p1')).toEqual([{ metric: 'steps', sourceIds: ['watch'] }])
    expect(store.load('p1').rank('steps', 'phone')).toBeGreaterThanOrEqual(UNRANKED_BASE)
  })

  it('keeps the default list separate from a metric list', () => {
    store.put({ personId: 'p1', metric: DEFAULT_LIST, sourceIds: ['phone', 'watch'], nowMs: 1 })
    store.put({ personId: 'p1', metric: 'weight', sourceIds: ['watch'], nowMs: 1 })
    const priority = store.load('p1')
    expect(priority.rank('steps', 'phone')).toBe(0)
    expect(priority.rank('weight', 'watch')).toBe(0)
  })

  it('marks the neighbourhood of each contested day, not the whole span between them', () => {
    // Both sources on both days, so both are contested. The days are adjacent, so their two
    // separate +/-1 neighbourhoods union into one unbroken run, the same run the old
    // mark-everything-between-first-and-last logic produced for this data by coincidence.
    insertAtHour(9)
    insertAtHour(24 + 9)
    insertSample(test.db, { personId: 'p1', sourceId: 'phone', metric: 'steps', utcMs: MIDNIGHT_UTC + 9 * 3_600_000, tzOffsetMinutes: OFFSET })
    insertSample(test.db, { personId: 'p1', sourceId: 'phone', metric: 'steps', utcMs: MIDNIGHT_UTC + (24 + 9) * 3_600_000, tzOffsetMinutes: OFFSET })
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone', 'watch'], nowMs: 1 })
    expect(markedDates()).toEqual(['2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24'])
  })

  it('computes the contested local date correctly when the earliest UTC row is not the earliest local row', () => {
    // Somebody who flew west: the later instant belongs to the earlier local day. Each source
    // reports at both instants, so both local days are contested regardless of which one the
    // earlier UTC row lands on.
    insertAt(Date.UTC(2026, 7, 22, 0, 0), 120)
    insertAt(Date.UTC(2026, 7, 22, 5, 0), -600)
    insertSample(test.db, { personId: 'p1', sourceId: 'phone', metric: 'steps', utcMs: Date.UTC(2026, 7, 22, 0, 0), tzOffsetMinutes: 120 })
    insertSample(test.db, { personId: 'p1', sourceId: 'phone', metric: 'steps', utcMs: Date.UTC(2026, 7, 22, 5, 0), tzOffsetMinutes: -600 })
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone', 'watch'], nowMs: 1 })

    expect(markedDates()).toEqual(['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'])
  })

  it('reads each row\'s own offset rather than sharing one across a day', () => {
    // +2 puts one row on 08-21 and -10 puts the other on 08-22. The SQL computes each row's
    // local date from that row's own offset, so nothing here can borrow one row's offset for
    // another the way a shared boundary read once could.
    insertAt(Date.UTC(2026, 7, 20, 23, 0), 120)
    insertAt(Date.UTC(2026, 7, 23, 1, 0), -600)
    insertSample(test.db, { personId: 'p1', sourceId: 'phone', metric: 'steps', utcMs: Date.UTC(2026, 7, 20, 23, 0), tzOffsetMinutes: 120 })
    insertSample(test.db, { personId: 'p1', sourceId: 'phone', metric: 'steps', utcMs: Date.UTC(2026, 7, 23, 1, 0), tzOffsetMinutes: -600 })
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone', 'watch'], nowMs: 1 })

    expect(markedDates()).toEqual(['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'])
  })

  it('marks nothing for a person with no samples yet', () => {
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone'], nowMs: 1 })
    expect(queue.size()).toBe(0)
  })

  it('marks the same days when a list is cleared', () => {
    insertAtHour(9)
    insertSample(test.db, { personId: 'p1', sourceId: 'phone', metric: 'steps', utcMs: MIDNIGHT_UTC + 9 * 3_600_000, tzOffsetMinutes: OFFSET })
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone', 'watch'], nowMs: 1 })
    queue.clear(queue.claim(100))
    store.clear({ personId: 'p1', metric: 'steps', nowMs: 2 })
    expect(store.lists('p1')).toEqual([])
    expect(markedDates()).toEqual(['2026-08-21', '2026-08-22', '2026-08-23'])
  })

  it('rejects a source id belonging to somebody else in the household', () => {
    // The foreign key is on sources.id alone, so nothing below this store would object.
    expect(() => store.put({
      personId: 'p1', metric: 'steps', sourceIds: ['watch', 'their-watch'], nowMs: 1,
    })).toThrow(ConfigError)
    expect(store.lists('p1')).toEqual([])
  })

  it('keeps one person\'s configured lists out of another person\'s', () => {
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone', 'watch'], nowMs: 1 })
    expect(store.lists('p2')).toEqual([])
    expect(store.load('p2').rank('steps', 'phone')).toBeGreaterThanOrEqual(UNRANKED_BASE)
  })
})

const queuedDates = (personId = 'p1'): string[] =>
  test.db.select().from(deriveQueueTable).all()
    .filter((r) => r.personId === personId)
    .map((r) => r.localDate)
    .sort()

describe('marks only contested days', () => {
  it('leaves a single source day alone', () => {
    // One source, one day. No ranking can change what a lone source reported.
    insertSample(test.db, {
      personId: 'p1', sourceId: 'watch', metric: 'steps',
      utcMs: MIDNIGHT_UTC + 3_600_000, tzOffsetMinutes: OFFSET,
    })
    store.put({ personId: 'p1', metric: DEFAULT_LIST, sourceIds: ['phone', 'watch'], nowMs: 1 })
    expect(queuedDates()).toEqual([])
  })

  it('marks a day two sources both reported on, and its neighbours', () => {
    const utcMs = MIDNIGHT_UTC + 3_600_000
    insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs, tzOffsetMinutes: OFFSET })
    insertSample(test.db, { personId: 'p1', sourceId: 'phone', metric: 'steps', utcMs, tzOffsetMinutes: OFFSET })
    store.put({ personId: 'p1', metric: DEFAULT_LIST, sourceIds: ['phone', 'watch'], nowMs: 1 })
    // A night spans midnight, so sessionOverlap reads across the boundary and the neighbours go too.
    expect(queuedDates()).toEqual(['2026-08-21', '2026-08-22', '2026-08-23'])
  })

  it('marks a day two sources wrote sessions on', () => {
    test.db.insert(sessions).values([
      {
        id: 's1', personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: 'a',
        startMs: 0, startOffsetMinutes: 0, endMs: 0, endOffsetMinutes: 0,
        localDate: '2026-08-22', attrs: '{}', rawPayloadId: null,
      },
      {
        id: 's2', personId: 'p1', sourceId: 'phone', kind: 'sleep', externalId: 'b',
        startMs: 0, startOffsetMinutes: 0, endMs: 0, endOffsetMinutes: 0,
        localDate: '2026-08-22', attrs: '{}', rawPayloadId: null,
      },
    ]).run()
    store.put({ personId: 'p1', metric: DEFAULT_LIST, sourceIds: ['phone', 'watch'], nowMs: 1 })
    expect(queuedDates()).toEqual(['2026-08-21', '2026-08-22', '2026-08-23'])
  })

  it('narrows clear the same way it narrows put', () => {
    const utcMs = MIDNIGHT_UTC + 3_600_000
    insertSample(test.db, { personId: 'p1', sourceId: 'watch', metric: 'steps', utcMs, tzOffsetMinutes: OFFSET })
    store.clear({ personId: 'p1', metric: DEFAULT_LIST, nowMs: 1 })
    expect(queuedDates()).toEqual([])
  })
})
