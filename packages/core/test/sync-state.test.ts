import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { SyncStateStore } from '../src/store/syncState.ts'
import { ExcludedDataTypeStore } from '../src/store/excludedDataTypes.ts'
import { DATA_TYPES } from '../src/api/catalogue.ts'
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

  it('lists a job for every data type carrying an action, and every person given', () => {
    seedPerson(ctx.db, 'p2')
    const jobs = store.dueJobs(['p1', 'p2'], 1000)
    const types = new Set(jobs.map((j) => j.dataType))
    expect(jobs.filter((j) => j.personId === 'p1').length).toBe(types.size)
    // Pinned to the full catalogue rather than a couple of spot checks: a set this size would
    // also pass spot checks on 'steps' and 'floors' if the filter were dropped entirely, so
    // only equality against every id in DATA_TYPES actually detects that regression.
    // floors rejects list but answers rollUp, dailyRollUp and reconcile, so it is due too;
    // runJob is what dispatches on which action a type actually gets, not dueJobs.
    // food is the one id excluded: it carries no action at all (catalogue.ts's own comment on
    // the entry - there is no field to build a fetch from), and dueJobs filters on exactly that,
    // the same predicate this test's own title names.
    expect(types).toEqual(new Set(DATA_TYPES.filter((t) => t.actions.length > 0).map((t) => t.id)))
  })

  it('keeps one person state separate from another', () => {
    seedPerson(ctx.db, 'p2')
    store.recordSuccess({ personId: 'p1', dataType: 'steps', highWaterMs: 5000, nowMs: 6000 })
    expect(store.get('p2', 'steps')).toBeNull()
  })

  describe('dueJobs and exclusions', () => {
    let excluded: ExcludedDataTypeStore

    beforeEach(() => {
      seedPerson(ctx.db, 'p2')
      excluded = new ExcludedDataTypeStore(ctx.db)
    })

    // Pinned to the full catalogue minus the one excluded id, not a spot check: a set this size
    // would also pass a spot check on 'steps' alone if the filter dropped every type but one, or
    // if it were applied to the wrong person.
    it('omits an excluded type from that person\'s jobs and no other', () => {
      excluded.setFor({ personId: 'p1', dataTypeIds: ['weight'], nowMs: 1000 })
      const jobTypes = store.dueJobs(['p1'], 1000).map((j) => j.dataType)
      expect(new Set(jobTypes)).toEqual(
        new Set(DATA_TYPES.filter((t) => t.actions.length > 0 && t.id !== 'weight').map((t) => t.id)),
      )
    })

    it('does not apply one person\'s exclusion to another\'s jobs', () => {
      excluded.setFor({ personId: 'p1', dataTypeIds: ['weight'], nowMs: 1000 })
      const p2Types = new Set(store.dueJobs(['p2'], 1000).map((j) => j.dataType))
      expect(p2Types).toEqual(new Set(DATA_TYPES.filter((t) => t.actions.length > 0).map((t) => t.id)))
    })

    it('returns every listable-with-an-action type when the exclusion set is empty', () => {
      excluded.setFor({ personId: 'p1', dataTypeIds: [], nowMs: 1000 })
      const jobTypes = new Set(store.dueJobs(['p1'], 1000).map((j) => j.dataType))
      expect(jobTypes).toEqual(new Set(DATA_TYPES.filter((t) => t.actions.length > 0).map((t) => t.id)))
    })

    it('excludes correctly for each person when both are asked for in one call', () => {
      excluded.setFor({ personId: 'p1', dataTypeIds: ['weight'], nowMs: 1000 })
      const jobs = store.dueJobs(['p1', 'p2'], 1000)
      const typesFor = (personId: string) => new Set(jobs.filter((j) => j.personId === personId).map((j) => j.dataType))
      expect(typesFor('p1')).toEqual(
        new Set(DATA_TYPES.filter((t) => t.actions.length > 0 && t.id !== 'weight').map((t) => t.id)),
      )
      expect(typesFor('p2')).toEqual(new Set(DATA_TYPES.filter((t) => t.actions.length > 0).map((t) => t.id)))
    })
  })
})
