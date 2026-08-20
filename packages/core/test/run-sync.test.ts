import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { SourceRegistry } from '../src/store/sources.ts'
import { SyncStateStore } from '../src/store/syncState.ts'
import { HealthClient } from '../src/api/client.ts'
import { runSync } from '../src/sync/runSync.ts'
import { body } from '../src/testing/payloads.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

describe('runSync', () => {
  let ctx: TestDatabase

  // ReturnType<typeof vi.fn> loses vi.fn's generic default and widens to a union Mock that has
  // no usable call signature. Naming the mocked signature directly keeps it callable as fetch.
  const build = (fetchMock: Mock<typeof globalThis.fetch>) => {
    const archive = new RawArchive(ctx.db)
    return {
      db: ctx.db, archive,
      sources: new SourceRegistry(ctx.db),
      syncState: new SyncStateStore(ctx.db),
      client: new HealthClient(
        { accessTokenFor: async () => 'at' }, archive,
        { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 },
      ),
      now: () => Date.parse('2026-08-19T12:00:00Z'),
    }
  }

  beforeEach(() => {
    ctx = createTestDatabase()
    seedPerson(ctx.db, 'alice', { timezone: 'Europe/Amsterdam' })
    seedPerson(ctx.db, 'bob', { timezone: 'UTC' })
  })
  afterEach(() => { ctx.cleanup(); vi.restoreAllMocks() })

  it('runs a job per person and listable data type', async () => {
    // mockImplementation rather than mockResolvedValue: a run spans many jobs and windows,
    // therefore many fetch calls, and a Response body can only be read once.
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
    const report = await runSync({
      personIds: ['alice', 'bob'], trailingDays: 1, deps: build(fetchMock),
    })
    expect(report.jobs).toBeGreaterThan(0)
    expect(report.failed).toBe(0)
  })

  it('uses each person own timezone, so a household spanning zones syncs correct days', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
    await runSync({ personIds: ['alice', 'bob'], trailingDays: 1, deps: build(fetchMock) })
    const filters = fetchMock.mock.calls
      .map((c) => new URL(String(c[0])).searchParams.get('filter'))
      .filter((f): f is string => f !== null)
    expect(new Set(filters).size).toBeGreaterThan(1)
  })

  it('keeps going when one person fails, because a household is not one account', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      String(url).includes('users/me') && fetchMock.mock.calls.length === 1
        ? new Response('{"error":{"code":400}}', { status: 400 })
        : new Response(body([]), { status: 200 }))
    const report = await runSync({
      personIds: ['alice', 'bob'], trailingDays: 1, deps: build(fetchMock),
    })
    expect(report.failed).toBeGreaterThan(0)
    expect(report.succeeded).toBeGreaterThan(0)
  })

  it('reports what it did, so a caller can show progress without reading the database', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
    const report = await runSync({ personIds: ['alice'], trailingDays: 1, deps: build(fetchMock) })
    expect(report).toMatchObject({
      jobs: expect.any(Number), succeeded: expect.any(Number),
      failed: expect.any(Number), skipped: expect.any(Number),
    })
  })
})
