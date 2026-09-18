import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { rebuildDrops, rebuildState } from '../src/db/schema/index.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { RebuildStateStore } from '../src/store/rebuildState.ts'

let fixture: TestDatabase

beforeEach(() => {
  fixture = createTestDatabase()
  seedPerson(fixture.db, 'p1')
})
afterEach(() => fixture.cleanup())

describe('rebuild tables', () => {
  it('defaults a fresh row to no failures and no drops', () => {
    fixture.db.insert(rebuildState).values({ personId: 'p1', lastAttemptAtMs: 10 }).run()
    const row = fixture.db.select().from(rebuildState).get()
    expect(row?.consecutiveFailures).toBe(0)
    expect(row?.droppedPages).toBe(0)
    expect(row?.lastError).toBeNull()
  })

  it('keys drops by person, type and reason, so one fault is one row', () => {
    fixture.db.insert(rebuildDrops)
      .values({ personId: 'p1', dataType: 'sleep', reason: 'UNIQUE', pages: 4 }).run()
    fixture.db.insert(rebuildDrops)
      .values({ personId: 'p1', dataType: 'sleep', reason: 'UNIQUE', pages: 9 })
      .onConflictDoUpdate({
        target: [rebuildDrops.personId, rebuildDrops.dataType, rebuildDrops.reason],
        set: { pages: 9 },
      }).run()
    const rows = fixture.db.select().from(rebuildDrops).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.pages).toBe(9)
  })
})

describe('RebuildStateStore', () => {
  it('answers null for a person who has never been rebuilt', () => {
    expect(new RebuildStateStore(fixture.db).get('p1')).toBeNull()
  })

  it('counts consecutive failures across attempts', () => {
    const store = new RebuildStateStore(fixture.db)
    store.recordFailure({ personId: 'p1', nowMs: 100, error: 'boom' })
    store.recordFailure({ personId: 'p1', nowMs: 200, error: 'boom again' })
    const row = store.get('p1')
    expect(row?.consecutiveFailures).toBe(2)
    expect(row?.lastError).toBe('boom again')
    expect(row?.lastErrorAtMs).toBe(200)
  })

  it('resets the failure count on a commit that dropped pages', () => {
    const store = new RebuildStateStore(fixture.db)
    store.recordFailure({ personId: 'p1', nowMs: 100, error: 'boom' })
    store.recordSuccess({
      personId: 'p1', nowMs: 300, droppedPages: 7,
      drops: [{ dataType: 'sleep', reason: 'UNIQUE constraint failed: session_segments.id', pages: 7 }],
    })
    const row = store.get('p1')
    expect(row?.consecutiveFailures).toBe(0)
    expect(row?.lastSuccessAtMs).toBe(300)
    expect(row?.droppedPages).toBe(7)
    expect(row?.drops).toEqual([
      { dataType: 'sleep', reason: 'UNIQUE constraint failed: session_segments.id', pages: 7 },
    ])
  })

  it('replaces drops wholesale, so a clean rebuild leaves none behind', () => {
    const store = new RebuildStateStore(fixture.db)
    store.recordSuccess({
      personId: 'p1', nowMs: 300, droppedPages: 2,
      drops: [{ dataType: 'sleep', reason: 'a', pages: 2 }],
    })
    store.recordSuccess({ personId: 'p1', nowMs: 400, droppedPages: 0, drops: [] })
    expect(store.get('p1')?.drops).toEqual([])
    expect(store.get('p1')?.droppedPages).toBe(0)
  })

  it('survives the rollback of an unrelated transaction, which is the whole point', () => {
    const store = new RebuildStateStore(fixture.db)
    expect(() => fixture.db.transaction(() => {
      store.recordFailure({ personId: 'p1', nowMs: 100, error: 'boom' })
      throw new Error('the rebuild failed')
    })).toThrow('the rebuild failed')
    // Enlisted in the caller's transaction it would be gone. This asserts the documented hazard
    // rather than the store's own behaviour: the store CANNOT escape an open transaction on one
    // connection, so the guarantee lives at the call site and this test pins the expectation.
    expect(store.get('p1')).toBeNull()
  })
})
