import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { rebuildDrops, rebuildState } from '../src/db/schema/index.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { RebuildStateStore, isQuarantined } from '../src/store/rebuildState.ts'

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

  // A stale error beside a fresh success is the loudest thing on the surfaces that read this
  // row: RebuildNotice renders lastError verbatim under its own heading whenever the column is
  // non-null, independent of whether anything is currently wrong. Leaving it standing showed a
  // degraded-but-healthy person the error text of an attempt a later rebuild had already
  // superseded, with nothing on screen saying it was historical. The same argument the
  // consecutive_failures reset is already made on applies here and applies harder.
  it('clears the recorded error when a later rebuild commits', () => {
    const store = new RebuildStateStore(fixture.db)
    store.recordFailure({ personId: 'p1', nowMs: 100, error: 'UNIQUE constraint failed: samples.id' })
    store.recordSuccess({ personId: 'p1', nowMs: 300, droppedPages: 0, drops: [] })
    const row = store.get('p1')
    expect(row?.lastError).toBeNull()
    expect(row?.lastErrorAtMs).toBeNull()
    expect(row?.lastSuccessAtMs).toBe(300)
  })

  // The tie the old timestamp comparison got wrong. A success and a later failure inside the
  // same millisecond - which a rebuild of a person with little data and a mocked clock produces
  // readily - left lastSuccessAtMs === lastErrorAtMs, and `lastSuccessAtMs < lastErrorAtMs` read
  // that as not quarantined, hiding a real one. recordSuccess clearing the error columns is what
  // makes the two timestamps unable to coexist at all, so the question no longer arises.
  it('reads a failure recorded in the same millisecond as an earlier success as quarantined', () => {
    const store = new RebuildStateStore(fixture.db)
    store.recordSuccess({ personId: 'p1', nowMs: 100, droppedPages: 0, drops: [] })
    store.recordFailure({ personId: 'p1', nowMs: 100, error: 'boom' })
    expect(isQuarantined(store.get('p1'))).toBe(true)
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
