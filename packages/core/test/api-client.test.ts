import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { HealthClient } from '../src/api/client.ts'
import { dataTypeById } from '../src/api/catalogue.ts'
import { rawPayloads } from '../src/db/schema/index.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

const page = (points: unknown[], nextPageToken?: string) =>
  new Response(JSON.stringify({ dataPoints: points, ...(nextPageToken ? { nextPageToken } : {}) }), { status: 200 })

const WINDOW = { windowStartMs: Date.UTC(2026, 7, 18), windowEndMs: Date.UTC(2026, 7, 19) }

describe('HealthClient', () => {
  let ctx: TestDatabase
  let archive: RawArchive
  const tokens = { accessTokenFor: async () => 'at-1' }

  beforeEach(() => {
    ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    archive = new RawArchive(ctx.db)
  })
  afterEach(() => { ctx.cleanup(); vi.restoreAllMocks() })

  it('builds a snake case filter on the member the catalogue declares', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {} })
    await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('heart-rate')!, ...WINDOW })
    const url = new URL(fetchMock.mock.calls[0]?.[0] as string)
    expect(url.pathname).toBe('/v4/users/me/dataTypes/heart-rate/dataPoints')
    expect(url.searchParams.get('filter')).toContain('heart_rate.sample_time.physical_time >=')
  })

  it('uses a plain date for the daily types, which reject a timestamp', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {} })
    await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('daily-resting-heart-rate')!, ...WINDOW })
    const filter = new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get('filter') ?? ''
    expect(filter).toContain('daily_resting_heart_rate.date >= "2026-08-18"')
    expect(filter).not.toContain('T00:00:00')
  })

  it('follows pagination until the token runs out', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page([{ a: 1 }], 'tok-2'))
      .mockResolvedValueOnce(page([{ a: 2 }], 'tok-3'))
      .mockResolvedValueOnce(page([{ a: 3 }]))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {} })
    const result = await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW })
    expect(result.pagesFetched).toBe(3)
    expect(result.pointCount).toBe(3)
    expect(result.payloadIds).toHaveLength(3)
  })

  it('archives every page, including one that fails, before anything parses it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 400, message: 'bad filter' } }), { status: 400 }),
    )
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {} })
    await expect(client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW }))
      .rejects.toThrow(/400/)
    const rows = ctx.db.select().from(rawPayloads).where(eq(rawPayloads.httpStatus, 400)).all()
    expect(rows).toHaveLength(1)
  })

  it('retries a 429 with backoff and then succeeds', async () => {
    const slept: number[] = []
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(page([{ a: 1 }]))
    const client = new HealthClient(tokens, archive, {
      fetch: fetchMock, now: () => 1, sleep: async (ms) => { slept.push(ms) },
    })
    const result = await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW })
    expect(result.pointCount).toBe(1)
    expect(slept).toHaveLength(1)
    expect(slept[0]).toBeGreaterThan(0)
  })

  it('gives up after the retry budget rather than hammering', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('still sad', { status: 503 }))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {} })
    await expect(client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW }))
      .rejects.toThrow(/503/)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5)
  })

  it('refuses a type the API does not support listing, without calling it', async () => {
    const fetchMock = vi.fn()
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {} })
    await expect(client.listDataPoints({ personId: 'p1', dataType: dataTypeById('floors')!, ...WINDOW }))
      .rejects.toThrow(/does not support list/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
