import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { HealthClient } from '../src/api/client.ts'
import { RevokedError } from '../src/api/tokens.ts'
import { ConfigError, TransientError } from '../src/errors.ts'
import { dataTypeById } from '../src/api/catalogue.ts'
import { rawPayloads } from '../src/db/schema/index.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

const page = (points: unknown[], nextPageToken?: string) =>
  new Response(JSON.stringify({ dataPoints: points, ...(nextPageToken ? { nextPageToken } : {}) }), { status: 200 })

const WINDOW = { windowStartMs: Date.UTC(2026, 7, 18), windowEndMs: Date.UTC(2026, 7, 19), timezone: 'UTC' }

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
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('heart-rate')!, ...WINDOW })
    const url = new URL(fetchMock.mock.calls[0]?.[0] as string)
    expect(url.pathname).toBe('/v4/users/me/dataTypes/heart-rate/dataPoints')
    expect(url.searchParams.get('filter')).toContain('heart_rate.sample_time.physical_time >=')
  })

  it('uses a plain date for the daily types, which reject a timestamp', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('daily-resting-heart-rate')!, ...WINDOW })
    const filter = new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get('filter') ?? ''
    expect(filter).toContain('daily_resting_heart_rate.date >= "2026-08-18"')
    expect(filter).not.toContain('T00:00:00')
  })

  it('names the local date for a date filtered type, not the UTC one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    // 2026-08-17 22:30 UTC is 2026-08-18 00:30 in Amsterdam (CEST, UTC+2): UTC and local
    // digits genuinely disagree on which day this instant belongs to.
    const start = Date.UTC(2026, 7, 17, 22, 30)
    const end = Date.UTC(2026, 7, 18, 22, 30)
    await client.listDataPoints({
      personId: 'p1', dataType: dataTypeById('daily-resting-heart-rate')!,
      windowStartMs: start, windowEndMs: end, timezone: 'Europe/Amsterdam',
    })
    const filter = new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get('filter') ?? ''
    expect(filter).toContain('daily_resting_heart_rate.date >= "2026-08-18"')
  })

  it('carries local wall clock digits for a civil timestamp type, not the UTC ones', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    const start = Date.UTC(2026, 7, 17, 22, 30)
    const end = Date.UTC(2026, 7, 18, 22, 30)
    await client.listDataPoints({
      personId: 'p1', dataType: dataTypeById('exercise')!,
      windowStartMs: start, windowEndMs: end, timezone: 'Europe/Amsterdam',
    })
    const filter = new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get('filter') ?? ''
    expect(filter).toContain('exercise.interval.civil_start_time >= "2026-08-18T00:30:00"')
  })

  it('follows pagination until the token runs out', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page([{ a: 1 }], 'tok-2'))
      .mockResolvedValueOnce(page([{ a: 2 }], 'tok-3'))
      .mockResolvedValueOnce(page([{ a: 3 }]))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    const result = await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW })
    expect(result.pagesFetched).toBe(3)
    expect(result.pointCount).toBe(3)
    expect(result.payloadIds).toHaveLength(3)
  })

  it('archives every page, including one that fails, before anything parses it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 400, message: 'bad filter' } }), { status: 400 }),
    )
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
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
      fetch: fetchMock, now: () => 1, sleep: async (ms) => { slept.push(ms) }, random: () => 0,
    })
    const result = await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW })
    expect(result.pointCount).toBe(1)
    expect(slept).toHaveLength(1)
    expect(slept[0]).toBeGreaterThan(0)
  })

  it('reports the retry it recovered from, since those bodies are deliberately never archived', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(page([{ a: 1 }]))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    const result = await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW })
    expect(result.pagesFetched).toBe(1)
    expect(result.attempts).toBe(2)
    expect(result.lastRetriedStatus).toBe(429)
  })

  it('reports no retry when every page answered first time', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page([{ a: 1 }], 'tok-2'))
      .mockResolvedValueOnce(page([{ a: 2 }]))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    const result = await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW })
    expect(result.attempts).toBe(result.pagesFetched)
    expect(result.lastRetriedStatus).toBeNull()
  })

  it('gives up after the retry budget rather than hammering', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('still sad', { status: 503 }))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    await expect(client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW }))
      .rejects.toThrow(/503/)
    expect(fetchMock.mock.calls.length).toBe(5)
  })

  it('refuses a type the API does not support listing, without calling it', async () => {
    const fetchMock = vi.fn()
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    await expect(client.listDataPoints({ personId: 'p1', dataType: dataTypeById('floors')!, ...WINDOW }))
      .rejects.toThrow(/does not support list/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries a transient token endpoint failure the same way it retries a transient data failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([{ a: 1 }]))
    const tokensMock = {
      accessTokenFor: vi.fn()
        // TransientError is what TokenProvider throws for a 503 from the token endpoint, so
        // this is the class the loop actually meets rather than a stand-in for it.
        .mockRejectedValueOnce(new TransientError('token refresh failed 503: upstream is sad'))
        .mockResolvedValueOnce('at-1'),
    }
    const client = new HealthClient(tokensMock, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    const result = await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW })
    expect(result.pointCount).toBe(1)
    expect(tokensMock.accessTokenFor).toHaveBeenCalledTimes(2)
  })

  it('still retries a token failure carrying no class, because an unclassified one may be transient', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([{ a: 1 }]))
    const tokensMock = {
      accessTokenFor: vi.fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce('at-1'),
    }
    const client = new HealthClient(tokensMock, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    const result = await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW })
    expect(result.pointCount).toBe(1)
    expect(tokensMock.accessTokenFor).toHaveBeenCalledTimes(2)
  })

  it('does not spend the retry budget on a token failure the taxonomy says retrying cannot fix', async () => {
    const fetchMock = vi.fn()
    const slept: number[] = []
    // What accessTokenFor throws for a person who never connected. Eighteen listable types
    // times four backoff sleeps is minutes per run of waiting to reach the same answer.
    const tokensMock = { accessTokenFor: vi.fn().mockRejectedValue(new ConfigError('person p1 is not connected')) }
    const client = new HealthClient(tokensMock, archive, {
      fetch: fetchMock, now: () => 1, sleep: async (ms) => { slept.push(ms) }, random: () => 0,
    })
    await expect(client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW }))
      .rejects.toThrow(/is not connected/)
    expect(tokensMock.accessTokenFor).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lets a RevokedError through immediately, without consuming the retry budget', async () => {
    const fetchMock = vi.fn()
    const tokensMock = { accessTokenFor: vi.fn().mockRejectedValue(new RevokedError('p1')) }
    const client = new HealthClient(tokensMock, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    await expect(client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW }))
      .rejects.toBeInstanceOf(RevokedError)
    expect(tokensMock.accessTokenFor).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('produces different sleep sequences for two clients with different random implementations', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('still sad', { status: 503 }))
    const sleptA: number[] = []
    const sleptB: number[] = []
    const clientA = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async (ms) => { sleptA.push(ms) }, random: () => 0.1 })
    const clientB = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async (ms) => { sleptB.push(ms) }, random: () => 0.9 })
    await expect(clientA.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW })).rejects.toThrow(/503/)
    await expect(clientB.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW })).rejects.toThrow(/503/)
    expect(sleptA).not.toEqual(sleptB)
  })

  it('pins the exponential growth in backoff when random is fixed', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('still sad', { status: 503 }))
    const slept: number[] = []
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async (ms) => { slept.push(ms) }, random: () => 0 })
    await expect(client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW })).rejects.toThrow(/503/)
    expect(slept).toEqual([500, 1000, 2000, 4000])
  })

  it('treats an HTML body arriving with status 200 as an empty terminal page rather than crashing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html><body>502 Bad Gateway</body></html>', { status: 200 }))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    const result = await client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW })
    expect(result.pointCount).toBe(0)
    expect(result.pagesFetched).toBe(1)
    expect(result.payloadIds).toHaveLength(1)
  })

  it('stops and throws rather than looping forever when nextPageToken never advances', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => page([{ a: 1 }], 'same-token'))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    await expect(client.listDataPoints({ personId: 'p1', dataType: dataTypeById('steps')!, ...WINDOW }))
      .rejects.toThrow(/exceeded/)
  })

  it('throws on a reversed window rather than silently querying nothing', async () => {
    const fetchMock = vi.fn()
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })
    await expect(client.listDataPoints({
      personId: 'p1', dataType: dataTypeById('steps')!, timezone: 'UTC',
      windowStartMs: WINDOW.windowEndMs, windowEndMs: WINDOW.windowStartMs,
    })).rejects.toThrow(/window must be ordered/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
