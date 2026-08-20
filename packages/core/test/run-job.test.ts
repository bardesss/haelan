import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { SourceRegistry } from '../src/store/sources.ts'
import { SyncStateStore } from '../src/store/syncState.ts'
import { HealthClient } from '../src/api/client.ts'
import { dataTypeById } from '../src/api/catalogue.ts'
import { runJob } from '../src/sync/runJob.ts'
import { RevokedError } from '../src/api/tokens.ts'
import { samplePoint, sleepPoint, body } from '../src/testing/payloads.ts'
import { samples, sessions, syncState } from '../src/db/schema/index.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

const AMS = 'Europe/Amsterdam'
const spo2Point = (physicalTime: string, value: number) => samplePoint({
  payloadKey: 'oxygenSaturation', valuePath: 'percentage', value, physicalTime,
})

describe('runJob', () => {
  let ctx: TestDatabase

  // ReturnType<typeof vi.fn> loses vi.fn's generic default and widens to a union Mock that has
  // no usable call signature. Naming the mocked signature directly keeps it callable as fetch.
  const build = (fetchMock: Mock<typeof globalThis.fetch>) => {
    const archive = new RawArchive(ctx.db)
    return {
      db: ctx.db,
      archive,
      sources: new SourceRegistry(ctx.db),
      syncState: new SyncStateStore(ctx.db),
      client: new HealthClient(
        { accessTokenFor: async () => 'at' }, archive,
        { fetch: fetchMock, now: () => 1_000_000, sleep: async () => {}, random: () => 0 },
      ),
      now: () => Date.parse('2026-08-19T12:00:00Z'),
    }
  }

  beforeEach(() => {
    ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1', { timezone: AMS })
  })
  afterEach(() => { ctx.cleanup(); vi.restoreAllMocks() })

  it('fetches each day of the window and writes rows', async () => {
    // mockImplementation rather than mockResolvedValue: a job spans several day windows and
    // therefore several fetch calls, and a Response body can only be read once.
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([spo2Point('2026-08-18T10:00:00Z', 97)]), { status: 200 }))
    const result = await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-17T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: build(fetchMock),
    })
    expect(result.windows).toBeGreaterThan(0)
    expect(result.rowsWritten).toBeGreaterThan(0)
    expect(ctx.db.select().from(samples).all().length).toBeGreaterThan(0)
  })

  it('attributes every row to a source derived from its own payload', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([spo2Point('2026-08-18T10:00:00Z', 97)]), { status: 200 }))
    await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: build(fetchMock),
    })
    const rows = ctx.db.select().from(samples).all()
    expect(rows.every((r) => r.sourceId.length > 0)).toBe(true)
  })

  it('is idempotent, so a second run over the same window changes nothing', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([spo2Point('2026-08-18T10:00:00Z', 97)]), { status: 200 }))
    const args = {
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
    }
    await runJob({ ...args, deps: build(fetchMock) })
    const after = ctx.db.select().from(samples).all().length
    await runJob({ ...args, deps: build(fetchMock) })
    expect(ctx.db.select().from(samples).all().length).toBe(after)
  })

  it('advances the high water mark on success', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([spo2Point('2026-08-18T10:00:00Z', 97)]), { status: 200 }))
    await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: build(fetchMock),
    })
    const state = ctx.db.select().from(syncState).where(eq(syncState.personId, 'p1')).all()[0]
    expect(state?.highWaterMs).toBeGreaterThan(0)
    expect(state?.consecutiveFailures).toBe(0)
  })

  it('records a failure and does not throw, because one bad job must not stop the others', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{"error":{"code":400}}', { status: 400 }))
    const result = await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: build(fetchMock),
    })
    expect(result.rowsWritten).toBe(0)
    const state = ctx.db.select().from(syncState).all()[0]
    expect(state?.consecutiveFailures).toBe(1)
    expect(state?.lastError).toContain('schema_drift')
  })

  it('stops the job when the person is revoked, and says so', async () => {
    const archive = new RawArchive(ctx.db)
    const deps = {
      ...build(vi.fn()),
      client: new HealthClient(
        { accessTokenFor: async () => { throw new RevokedError('p1') } }, archive,
        { fetch: vi.fn(), now: () => 1, sleep: async () => {}, random: () => 0 },
      ),
    }
    const result = await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'), deps,
    })
    expect(result.skipped).toBe('revoked')
  })

  it('corrects every field of a session on a re-fetch, so no row contradicts itself', async () => {
    // Google finishes processing a night after it first serves it, and a corrected offset is one
    // of the things that changes. localDate is derived from the end offset, so a row that keeps
    // the old offset beside the new local date disagrees with itself.
    const night = (utcOffset: string) => body([sleepPoint({
      startTime: '2026-08-18T21:00:00Z', endTime: '2026-08-18T22:30:00Z', utcOffset,
      stages: [{ type: 'DEEP', startTime: '2026-08-18T21:00:00Z', endTime: '2026-08-18T22:30:00Z' }],
    })])
    const args = {
      personId: 'p1', dataType: dataTypeById('sleep')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
    }

    await runJob({ ...args, deps: build(vi.fn().mockImplementation(async () => new Response(night('7200s'), { status: 200 }))) })
    const first = ctx.db.select().from(sessions).all()[0]
    expect(first?.endOffsetMinutes).toBe(120)
    expect(first?.localDate).toBe('2026-08-19')

    await runJob({ ...args, deps: build(vi.fn().mockImplementation(async () => new Response(night('3600s'), { status: 200 }))) })
    const rows = ctx.db.select().from(sessions).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.startOffsetMinutes).toBe(60)
    expect(rows[0]?.endOffsetMinutes).toBe(60)
    expect(rows[0]?.localDate).toBe('2026-08-18')
    expect(rows[0]?.rawPayloadId).not.toBe(first?.rawPayloadId)
  })

  it('skips a type the API cannot list without calling it', async () => {
    const fetchMock = vi.fn()
    const result = await runJob({
      personId: 'p1', dataType: dataTypeById('floors')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: build(fetchMock),
    })
    expect(result.skipped).toBe('unsupported')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('takes a limiter token before each window it fetches, not after', async () => {
    const events: string[] = []
    const fetchMock = vi.fn().mockImplementation(async () => {
      events.push('fetch')
      return new Response(body([]), { status: 200 })
    })
    const result = await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-17T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: { ...build(fetchMock), limiter: { take: async () => { events.push('take') } } },
    })
    expect(result.windows).toBeGreaterThan(1)
    expect(events).toEqual(Array.from({ length: result.windows }, () => ['take', 'fetch']).flat())
  })

  it('records a retry episode the client recovered from, because those bodies are never archived', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response('slow down', { status: 429 }))
      .mockImplementation(async () => new Response(body([spo2Point('2026-08-18T10:00:00Z', 97)]), { status: 200 }))
    await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: build(fetchMock),
    })
    const state = ctx.db.select().from(syncState).all()[0]
    expect(state?.lastError).toContain('2 attempts')
    expect(state?.lastError).toContain('429')
    // A recovered retry is not a failure, so the count that pauses a person must not move.
    expect(state?.consecutiveFailures).toBe(0)
    expect(state?.highWaterMs).toBeGreaterThan(0)
  })

  it('leaves a failure recorded after a recovered retry in place, because last_error holds one string', async () => {
    let call = 0
    const fetchMock = vi.fn().mockImplementation(async () => {
      call++
      // First window: one 429 then a good page. Second window: a settled 400.
      if (call === 1) return new Response('slow down', { status: 429 })
      if (call === 2) return new Response(body([spo2Point('2026-08-18T10:00:00Z', 97)]), { status: 200 })
      return new Response('{"error":{"code":400}}', { status: 400 })
    })
    await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: build(fetchMock),
    })
    const state = ctx.db.select().from(syncState).all()[0]
    expect(state?.lastError).toContain('schema_drift')
    expect(state?.lastError).not.toContain('recovered')
    expect(state?.consecutiveFailures).toBe(1)
  })

  it('records a class for a failure that is not a HaelanError, because last_error promises one', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([spo2Point('2026-08-18T10:00:00Z', 97)]), { status: 200 }))
    // SqliteError, not a HaelanError, and neither is anything zlib or a mapper throws.
    ctx.db.$client.exec("CREATE TRIGGER haelan_test_busy BEFORE INSERT ON samples BEGIN SELECT RAISE(ABORT, 'database is locked'); END")
    await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: build(fetchMock),
    })
    ctx.db.$client.exec('DROP TRIGGER haelan_test_busy')
    const state = ctx.db.select().from(syncState).all()[0]
    expect(state?.lastError).toMatch(/^\[(auth|transient|schema_drift|data_quality|config)\] /)
    expect(state?.lastError).toContain('database is locked')
  })

  it('lets the next window write after one window rolled back, rather than cascading', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([spo2Point('2026-08-18T10:00:00Z', 97)]), { status: 200 }))
    const deps = build(fetchMock)
    const args = { personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS }

    // SQLITE_BUSY shaped, and deliberately raised by SQLite itself: the throw lands inside the
    // window's transaction after the source row has been inserted and cached, so the rollback
    // takes the source row away and leaves the cache entry pointing at nothing. WAL means the
    // MCP server, the CLI and a sync share the file, so a busy writer is not hypothetical.
    ctx.db.$client.exec("CREATE TRIGGER haelan_test_busy BEFORE INSERT ON samples BEGIN SELECT RAISE(ABORT, 'database is locked'); END")
    const first = await runJob({
      ...args, fromMs: Date.parse('2026-08-17T00:00:00Z'), toMs: Date.parse('2026-08-18T00:00:00Z'), deps,
    })
    expect(first.rowsWritten).toBe(0)
    ctx.db.$client.exec('DROP TRIGGER haelan_test_busy')

    const second = await runJob({
      ...args, fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'), deps,
    })
    expect(second.rowsWritten).toBeGreaterThan(0)
    expect(ctx.db.select().from(samples).all().length).toBeGreaterThan(0)
    expect(ctx.db.select().from(syncState).all()[0]?.lastError ?? '').not.toContain('FOREIGN KEY')
  })

  it('writes nothing for a deferred type, but still archives what it fetched', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
    const result = await runJob({
      personId: 'p1', dataType: dataTypeById('active-zone-minutes')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: build(fetchMock),
    })
    expect(result.rowsWritten).toBe(0)
    expect(fetchMock).toHaveBeenCalled()
  })
})
