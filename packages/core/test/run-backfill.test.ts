import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { SourceRegistry } from '../src/store/sources.ts'
import { SyncStateStore } from '../src/store/syncState.ts'
import { dataTypeById } from '../src/api/catalogue.ts'
import { runBackfill } from '../src/sync/runBackfill.ts'
import type { HealthClient, ListInput, ListResult } from '../src/api/client.ts'
import type { JobDeps } from '../src/sync/runJob.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

// 2026-03-01T12:00:00Z, a Sunday, comfortably away from a DST boundary in Europe/Amsterdam.
const NOW_MS = 1_772_366_400_000
const DAY_MS = 86_400_000
const AMS = 'Europe/Amsterdam'

let fixture: TestDatabase
let syncState: SyncStateStore

beforeEach(() => {
  fixture = createTestDatabase()
  seedPerson(fixture.db, 'p1', { timezone: AMS })
  syncState = new SyncStateStore(fixture.db)
})
afterEach(() => fixture.cleanup())

interface RecordedWindow { startMs: number, endMs: number }

// A client that records the window it was asked for and answers with nothing. runJob's own
// tests cover mapping; what a backfill test has to see is which windows were walked, in which
// order, and where the walk stopped.
function buildDeps(ctx: TestDatabase): {
  deps: JobDeps & { client: { failNextWith: Error | null } }
  windows: RecordedWindow[]
} {
  const windows: RecordedWindow[] = []
  const client = {
    failNextWith: null as Error | null,
    async listDataPoints(input: ListInput): Promise<ListResult> {
      windows.push({ startMs: input.windowStartMs, endMs: input.windowEndMs })
      if (client.failNextWith) {
        const error = client.failNextWith
        client.failNextWith = null
        throw error
      }
      return { payloadIds: [], pointCount: 0, pagesFetched: 1, attempts: 1, lastRetriedStatus: null }
    },
  }
  const deps = {
    db: ctx.db,
    archive: new RawArchive(ctx.db),
    sources: new SourceRegistry(ctx.db),
    syncState: new SyncStateStore(ctx.db),
    client: client as unknown as HealthClient,
    now: () => NOW_MS,
  } as JobDeps & { client: { failNextWith: Error | null } }
  return { deps, windows }
}

describe('runBackfill', () => {
  it('walks backwards from today rather than forwards from the horizon', async () => {
    const { deps, windows } = buildDeps(fixture)
    await runBackfill({
      personId: 'p1', timezone: AMS, dataType: dataTypeById('weight')!,
      nowMs: NOW_MS, batchDays: 3, deps,
    })
    expect(windows).toHaveLength(3)
    // Descending: the most recent day is fetched first, so an interrupted backfill has the
    // data a dashboard is most likely to be asked for.
    expect(windows[0]!.startMs).toBeGreaterThan(windows[1]!.startMs)
    expect(windows[1]!.startMs).toBeGreaterThan(windows[2]!.startMs)
  })

  it('records the cursor after every window, so a restart resumes rather than restarts', async () => {
    const { deps, windows } = buildDeps(fixture)
    await runBackfill({
      personId: 'p1', timezone: AMS, dataType: dataTypeById('weight')!,
      nowMs: NOW_MS, batchDays: 3, deps,
    })
    const cursor = syncState.get('p1', 'weight')?.backfillCursorMs
    expect(cursor).toBe(windows.at(-1)!.startMs)
  })

  it('resumes from the stored cursor instead of starting at today again', async () => {
    syncState.setBackfillCursor({ personId: 'p1', dataType: 'weight', cursorMs: NOW_MS - 10 * DAY_MS, nowMs: NOW_MS })
    const { deps, windows } = buildDeps(fixture)
    await runBackfill({
      personId: 'p1', timezone: AMS, dataType: dataTypeById('weight')!,
      nowMs: NOW_MS, batchDays: 2, deps,
    })
    expect(windows[0]!.endMs).toBeLessThanOrEqual(NOW_MS - 10 * DAY_MS)
  })

  it('stops at the type horizon and marks the backfill complete', async () => {
    const weight = { ...dataTypeById('weight')!, backfillHorizonDays: 2 }
    const { deps, windows } = buildDeps(fixture)
    const result = await runBackfill({
      personId: 'p1', timezone: AMS, dataType: weight, nowMs: NOW_MS, batchDays: 50, deps,
    })
    expect(windows.length).toBeLessThanOrEqual(3)
    expect(result).toMatchObject({ complete: true, stoppedBecause: 'horizon' })
    expect(syncState.get('p1', 'weight')?.backfillCompleteAtMs).not.toBeNull()
  })

  it('does nothing once the backfill is already complete', async () => {
    syncState.markBackfillComplete({ personId: 'p1', dataType: 'weight', nowMs: NOW_MS })
    const { deps, windows } = buildDeps(fixture)
    const result = await runBackfill({
      personId: 'p1', timezone: AMS, dataType: dataTypeById('weight')!,
      nowMs: NOW_MS, batchDays: 3, deps,
    })
    expect(windows).toHaveLength(0)
    expect(result).toMatchObject({ complete: true, stoppedBecause: 'horizon' })
  })

  it('yields after batchDays so one type cannot hold the runner for an hour', async () => {
    const { deps, windows } = buildDeps(fixture)
    const result = await runBackfill({
      personId: 'p1', timezone: AMS, dataType: dataTypeById('weight')!,
      nowMs: NOW_MS, batchDays: 4, deps,
    })
    expect(windows).toHaveLength(4)
    expect(result).toMatchObject({ complete: false, stoppedBecause: 'batch' })
    expect(syncState.get('p1', 'weight')?.backfillCompleteAtMs ?? null).toBeNull()
  })

  it('never moves the high water mark backwards', async () => {
    syncState.recordSuccess({ personId: 'p1', dataType: 'weight', highWaterMs: NOW_MS, nowMs: NOW_MS })
    const { deps } = buildDeps(fixture)
    await runBackfill({
      personId: 'p1', timezone: AMS, dataType: dataTypeById('weight')!,
      nowMs: NOW_MS, batchDays: 3, deps,
    })
    // recordSuccess takes the max, and every backfill window is in the past. A mark that went
    // backwards here would make the trailing sync re-fetch the whole gap every night.
    expect(syncState.get('p1', 'weight')?.highWaterMs).toBe(NOW_MS)
  })

  it('stops the walk when a window fails rather than marching to the horizon on errors', async () => {
    const { deps, windows } = buildDeps(fixture)
    deps.client.failNextWith = new Error('boom')
    const result = await runBackfill({
      personId: 'p1', timezone: AMS, dataType: dataTypeById('weight')!,
      nowMs: NOW_MS, batchDays: 10, deps,
    })
    expect(result.stoppedBecause).toBe('error')
    expect(windows.length).toBeLessThan(10)
  })

  it('skips a type the API cannot list at all', async () => {
    const { deps, windows } = buildDeps(fixture)
    const result = await runBackfill({
      personId: 'p1', timezone: AMS, dataType: dataTypeById('floors')!,
      nowMs: NOW_MS, batchDays: 10, deps,
    })
    expect(windows).toHaveLength(0)
    expect(result.complete).toBe(true)
  })

  it('reports every window it finished to a progress subscriber', async () => {
    const { deps } = buildDeps(fixture)
    const seen: string[] = []
    deps.onProgress = (event) => seen.push(event.kind)
    await runBackfill({
      personId: 'p1', timezone: AMS, dataType: dataTypeById('weight')!,
      nowMs: NOW_MS, batchDays: 2, deps,
    })
    expect(seen.filter((kind) => kind === 'window_done')).toHaveLength(2)
  })

  it('does not lose a window because a subscriber threw', async () => {
    const { deps, windows } = buildDeps(fixture)
    deps.onProgress = () => { throw new Error('the SSE client went away') }
    const result = await runBackfill({
      personId: 'p1', timezone: AMS, dataType: dataTypeById('weight')!,
      nowMs: NOW_MS, batchDays: 2, deps,
    })
    expect(windows).toHaveLength(2)
    expect(result.stoppedBecause).toBe('batch')
  })
})
