import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, insertSample, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { SourcePriorityStore } from '../src/store/sourcePriority.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { UNRANKED_BASE, DEFAULT_LIST } from '../src/derive/priority.ts'
import { ConfigError } from '../src/errors.ts'
import { sources } from '../src/db/schema/index.ts'

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

  it('marks every day the person has samples for, because changing priority is a rebuild', () => {
    insertAtHour(9)
    insertAtHour(24 + 9)
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone'], nowMs: 1 })
    // The two sample days plus the spare day at each end. An extra empty derive is the price of
    // never leaving a boundary day on the old merge.
    expect(markedDates()).toEqual(['2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24'])
  })

  it('marks both ends when the earliest UTC row is not the earliest local row', () => {
    // Somebody who flew west: the later instant belongs to the earlier local day. Taking the
    // min and max utcMs as the range ends inverts them, and an inverted range marks nothing.
    insertAt(Date.UTC(2026, 7, 22, 0, 0), 120)
    insertAt(Date.UTC(2026, 7, 22, 5, 0), -600)
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone'], nowMs: 1 })

    const dates = markedDates()
    expect(dates).not.toEqual([])
    expect(dates).toContain('2026-08-21')
    expect(dates).toContain('2026-08-22')
  })

  it('reads each boundary offset off its own row rather than sharing one', () => {
    // +2 puts the first row on 08-21 and -10 puts the last on 08-22. Reading the first row's
    // offset for both ends would push the far end to 08-23 and widen the range by a day.
    insertAt(Date.UTC(2026, 7, 20, 23, 0), 120)
    insertAt(Date.UTC(2026, 7, 23, 1, 0), -600)
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone'], nowMs: 1 })

    expect(markedDates()).toEqual(['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'])
  })

  it('marks nothing for a person with no samples yet', () => {
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone'], nowMs: 1 })
    expect(queue.size()).toBe(0)
  })

  it('marks the same days when a list is cleared', () => {
    insertAtHour(9)
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone'], nowMs: 1 })
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
