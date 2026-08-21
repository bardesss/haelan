import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { SyncStateStore } from '../src/store/syncState.ts'
import { TransientError, SchemaDriftError } from '../src/errors.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

describe('SyncStateStore', () => {
  let ctx: TestDatabase
  let store: SyncStateStore

  beforeEach(() => {
    ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    store = new SyncStateStore(ctx.db)
  })
  afterEach(() => ctx.cleanup())

  it('returns null for a job that has never run, which is how a backfill knows to start', () => {
    expect(store.get('p1', 'steps')).toBeNull()
  })

  it('records a success with its high water mark', () => {
    store.recordSuccess({ personId: 'p1', dataType: 'steps', highWaterMs: 5000, nowMs: 6000 })
    expect(store.get('p1', 'steps')).toMatchObject({ highWaterMs: 5000, lastSuccessAtMs: 6000, consecutiveFailures: 0 })
  })

  it('never moves the high water mark backwards, because a trailing window revisits old days', () => {
    store.recordSuccess({ personId: 'p1', dataType: 'steps', highWaterMs: 5000, nowMs: 6000 })
    store.recordSuccess({ personId: 'p1', dataType: 'steps', highWaterMs: 4000, nowMs: 7000 })
    expect(store.get('p1', 'steps')?.highWaterMs).toBe(5000)
  })

  it('records a failure with its class, so a caller need not read the message', () => {
    store.recordFailure({ personId: 'p1', dataType: 'steps', error: new SchemaDriftError('unknown field'), nowMs: 6000 })
    const state = store.get('p1', 'steps')
    expect(state?.lastErrorAtMs).toBe(6000)
    expect(state?.lastError).toContain('schema_drift')
    expect(state?.consecutiveFailures).toBe(1)
  })

  it('counts consecutive failures and resets the count on a success', () => {
    for (const n of [1, 2, 3]) {
      store.recordFailure({ personId: 'p1', dataType: 'steps', error: new TransientError(`try ${n}`), nowMs: n })
    }
    expect(store.get('p1', 'steps')?.consecutiveFailures).toBe(3)
    store.recordSuccess({ personId: 'p1', dataType: 'steps', highWaterMs: 10, nowMs: 10 })
    expect(store.get('p1', 'steps')?.consecutiveFailures).toBe(0)
  })

  it('records a retry episode that eventually succeeded, because the client discards those bodies', () => {
    store.recordRetryEpisode({ personId: 'p1', dataType: 'steps', attempts: 3, lastStatus: 429, nowMs: 6000 })
    const state = store.get('p1', 'steps')
    expect(state?.lastError).toBe('[transient] recovered after 3 attempts, last status 429')
    expect(state?.consecutiveFailures).toBe(0)
  })

  it('leaves an existing failure count untouched on a retry episode, since it did not fail', () => {
    store.recordFailure({ personId: 'p1', dataType: 'steps', error: new TransientError('try 1'), nowMs: 1 })
    store.recordFailure({ personId: 'p1', dataType: 'steps', error: new TransientError('try 2'), nowMs: 2 })
    store.recordRetryEpisode({ personId: 'p1', dataType: 'steps', attempts: 3, lastStatus: 429, nowMs: 6000 })
    expect(store.get('p1', 'steps')?.consecutiveFailures).toBe(2)
  })

  it('tracks a backfill cursor and its completion separately from the forward cursor', () => {
    store.setBackfillCursor({ personId: 'p1', dataType: 'steps', cursorMs: 1000, nowMs: 1 })
    expect(store.get('p1', 'steps')?.backfillCursorMs).toBe(1000)
    expect(store.get('p1', 'steps')?.backfillCompleteAtMs).toBeNull()
    store.markBackfillComplete({ personId: 'p1', dataType: 'steps', nowMs: 2000 })
    expect(store.get('p1', 'steps')?.backfillCompleteAtMs).toBe(2000)
  })

  it('clears a completion mark without touching the cursor, so a raised horizon can resume the walk', () => {
    store.setBackfillCursor({ personId: 'p1', dataType: 'steps', cursorMs: 1000, nowMs: 1 })
    store.markBackfillComplete({ personId: 'p1', dataType: 'steps', nowMs: 2000 })
    store.clearBackfillComplete('p1', 'steps')
    expect(store.get('p1', 'steps')?.backfillCompleteAtMs).toBeNull()
    expect(store.get('p1', 'steps')?.backfillCursorMs).toBe(1000)
  })

  it('lists a job for every listable data type and every person given', () => {
    seedPerson(ctx.db, 'p2')
    const jobs = store.dueJobs(['p1', 'p2'], 1000)
    const types = new Set(jobs.map((j) => j.dataType))
    expect(jobs.filter((j) => j.personId === 'p1').length).toBe(types.size)
    expect(types.has('steps')).toBe(true)
    expect(types.has('floors')).toBe(false)
  })

  it('keeps one person state separate from another', () => {
    seedPerson(ctx.db, 'p2')
    store.recordSuccess({ personId: 'p1', dataType: 'steps', highWaterMs: 5000, nowMs: 6000 })
    expect(store.get('p2', 'steps')).toBeNull()
  })
})
