import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { SourcePriorityStore } from '../src/store/sourcePriority.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { UNRANKED_BASE, DEFAULT_LIST } from '../src/derive/priority.ts'
import { samples, sources } from '../src/db/schema/index.ts'

const OFFSET = 120
const MIDNIGHT_UTC = Date.UTC(2026, 7, 21, 22, 0)

let test: TestDatabase
let store: SourcePriorityStore
let queue: DeriveQueue

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values([
    { id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0 },
    { id: 'phone', personId: 'p1', externalId: 'phone', displayName: 'phone', kind: 'app', createdAtMs: 0 },
  ]).run()
  queue = new DeriveQueue(test.db)
  store = new SourcePriorityStore(test.db, queue)
})
afterEach(() => test.cleanup())

const insertSample = (hour: number) =>
  test.db.insert(samples).values({
    personId: 'p1', sourceId: 'watch', metric: 'steps',
    utcMs: MIDNIGHT_UTC + hour * 3_600_000, tzOffsetMinutes: OFFSET,
    agg: 'raw', value: 1, n: 1, rawPayloadId: null,
  }).run()

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
    insertSample(9)
    insertSample(24 + 9)
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone'], nowMs: 1 })
    expect(queue.size()).toBe(2)
  })

  it('marks nothing for a person with no samples yet', () => {
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone'], nowMs: 1 })
    expect(queue.size()).toBe(0)
  })

  it('marks the same days when a list is cleared', () => {
    insertSample(9)
    store.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone'], nowMs: 1 })
    queue.clear(queue.claim(100))
    store.clear({ personId: 'p1', metric: 'steps', nowMs: 2 })
    expect(store.lists('p1')).toEqual([])
    expect(queue.size()).toBe(1)
  })
})
