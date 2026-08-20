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
import { samplePoint, body } from '../src/testing/payloads.ts'
import { samples, syncState } from '../src/db/schema/index.ts'
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
