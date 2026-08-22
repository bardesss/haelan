import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'

let test: TestDatabase
let queue: DeriveQueue
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  seedPerson(test.db, 'p2')
  queue = new DeriveQueue(test.db)
})
afterEach(() => test.cleanup())

describe('the derive queue', () => {
  it('queues a day once however many times it is marked', () => {
    // Eighteen data types writing into the same day is eighteen calls and one dirty day.
    for (let i = 0; i < 18; i++) queue.markDirty({ personId: 'p1', localDate: '2026-08-22', nowMs: i })
    expect(queue.size()).toBe(1)
  })

  it('keeps people apart', () => {
    queue.markDirty({ personId: 'p1', localDate: '2026-08-22', nowMs: 1 })
    queue.markDirty({ personId: 'p2', localDate: '2026-08-22', nowMs: 1 })
    expect(queue.size()).toBe(2)
  })

  it('claims the oldest first and no more than asked for', () => {
    queue.markDirty({ personId: 'p1', localDate: '2026-08-20', nowMs: 3 })
    queue.markDirty({ personId: 'p1', localDate: '2026-08-21', nowMs: 1 })
    queue.markDirty({ personId: 'p1', localDate: '2026-08-22', nowMs: 2 })
    expect(queue.claim(2)).toEqual([
      { personId: 'p1', localDate: '2026-08-21' },
      { personId: 'p1', localDate: '2026-08-22' },
    ])
  })

  it('leaves a claimed day queued until it is cleared, so a crash mid-derive redoes it', () => {
    queue.markDirty({ personId: 'p1', localDate: '2026-08-22', nowMs: 1 })
    queue.claim(10)
    expect(queue.size()).toBe(1)
    queue.clear([{ personId: 'p1', localDate: '2026-08-22' }])
    expect(queue.size()).toBe(0)
  })

  it('marks an inclusive range, which is what a rebuild needs', () => {
    queue.markRange({ personId: 'p1', fromLocalDate: '2026-08-20', toLocalDate: '2026-08-22', nowMs: 1 })
    expect(queue.claim(10).map((e) => e.localDate)).toEqual(['2026-08-20', '2026-08-21', '2026-08-22'])
  })

  it('clears nothing when handed nothing', () => {
    queue.markDirty({ personId: 'p1', localDate: '2026-08-22', nowMs: 1 })
    queue.clear([])
    expect(queue.size()).toBe(1)
  })
})
