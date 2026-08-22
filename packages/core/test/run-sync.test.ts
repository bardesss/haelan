import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { SourceRegistry } from '../src/store/sources.ts'
import { SyncStateStore } from '../src/store/syncState.ts'
import { HealthClient } from '../src/api/client.ts'
import { runSync, reachBackTo } from '../src/sync/runSync.ts'
import { DATA_TYPES, DEFAULT_USER_HORIZON_DAYS, INTRADAY_HORIZON_DAYS, supports } from '../src/api/catalogue.ts'
import { body } from '../src/testing/payloads.ts'
import { rawPayloads } from '../src/db/schema/index.ts'
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

  const DAY_MS = 86_400_000
  const listable = () => DATA_TYPES.filter((t) => supports(t, 'list'))
  const windowStartsFor = (personId: string) =>
    ctx.db.select({ personId: rawPayloads.personId, windowStartMs: rawPayloads.windowStartMs })
      .from(rawPayloads).all().filter((r) => r.personId === personId).map((r) => r.windowStartMs)

  // Spec section 16 promises that after an offline stretch sync resumes from sync_state and
  // backfills the gap. The trailing window alone cannot keep that promise: it is a fixed span
  // ending at now, so an outage longer than the span leaves days that no trailing run will ever
  // ask for and no backfill will either, because the backfill cursor only walks backwards. The
  // high-water mark is what says where the mirror actually stops.
  it('reaches back to the high-water mark when an outage outran the trailing window', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
    const deps = build(fetchMock)
    const nowMs = deps.now()
    const staleMs = nowMs - 30 * DAY_MS
    for (const type of listable()) {
      deps.syncState.recordSuccess({ personId: 'alice', dataType: type.id, highWaterMs: staleMs, nowMs: staleMs })
    }

    await runSync({ personIds: ['alice'], trailingDays: 7, userHorizonDays: DEFAULT_USER_HORIZON_DAYS, deps })

    const starts = windowStartsFor('alice')
    expect(starts.length).toBeGreaterThan(0)
    expect(Math.min(...starts), 'earliest window must reach the mark, not just the trailing span')
      .toBeLessThanOrEqual(staleMs)
  })

  it('still fetches the trailing window when the mark is more recent than it', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
    const deps = build(fetchMock)
    const nowMs = deps.now()
    for (const type of listable()) {
      deps.syncState.recordSuccess({ personId: 'alice', dataType: type.id, highWaterMs: nowMs - DAY_MS, nowMs })
    }

    await runSync({ personIds: ['alice'], trailingDays: 7, userHorizonDays: DEFAULT_USER_HORIZON_DAYS, deps })

    // A device that uploads late is the whole reason the trailing window exists, so a recent
    // mark must never shorten it.
    expect(Math.min(...windowStartsFor('alice'))).toBeLessThanOrEqual(nowMs - 7 * DAY_MS)
  })

  // Exercised on the decision rather than through a run: an 18-type mirror 900 days stale is
  // 13,000 windows of real gzip and SQLite, which is a statement about how expensive a very old
  // mark is, not about whether the clamp holds.
  describe('how far back one run reaches', () => {
    const nowMs = Date.parse('2026-08-19T12:00:00Z')
    const trailingFromMs = nowMs - 7 * DAY_MS
    const daily = DATA_TYPES.find((t) => supports(t, 'list') && t.tier !== 'intraday')!
    const intraday = DATA_TYPES.find((t) => supports(t, 'list') && t.tier === 'intraday')!

    it('reaches only the trailing window when there is no mark to reach for', () => {
      expect(reachBackTo(null, trailingFromMs, nowMs, daily, DEFAULT_USER_HORIZON_DAYS)).toBe(trailingFromMs)
    })

    it('keeps the full trailing window when the mark is inside it', () => {
      const mark = nowMs - 2 * DAY_MS
      expect(reachBackTo(mark, trailingFromMs, nowMs, daily, DEFAULT_USER_HORIZON_DAYS)).toBe(trailingFromMs)
    })

    it('reaches back to the mark when the mark is older than the trailing window', () => {
      const mark = nowMs - 30 * DAY_MS
      expect(reachBackTo(mark, trailingFromMs, nowMs, daily, DEFAULT_USER_HORIZON_DAYS)).toBe(mark)
    })

    it('stops at the account horizon rather than following a very old mark', () => {
      const mark = nowMs - 900 * DAY_MS
      expect(reachBackTo(mark, trailingFromMs, nowMs, daily, DEFAULT_USER_HORIZON_DAYS))
        .toBe(nowMs - DEFAULT_USER_HORIZON_DAYS * DAY_MS)
    })

    // An intraday type's ceiling is its own, not the account's, so a gap repair must not use a
    // generous user horizon to reach for sample-level history the API no longer serves.
    it('stops an intraday type at the intraday horizon even when the account asks for more', () => {
      const mark = nowMs - 900 * DAY_MS
      expect(reachBackTo(mark, trailingFromMs, nowMs, intraday, DEFAULT_USER_HORIZON_DAYS))
        .toBe(nowMs - INTRADAY_HORIZON_DAYS * DAY_MS)
    })
  })

  // Today's window ends at the next local midnight, so the naive mark is up to a day ahead of
  // now. Nothing read the mark before, which is how it went unnoticed; the gap repair above is
  // its first consumer and would subtract a day of real coverage from every run.
  it('never stamps the high-water mark in the future', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
    const deps = build(fetchMock)
    await runSync({ personIds: ['alice'], trailingDays: 1, userHorizonDays: DEFAULT_USER_HORIZON_DAYS, deps })

    for (const type of listable()) {
      const mark = deps.syncState.get('alice', type.id)?.highWaterMs
      if (mark == null) continue
      expect(mark, `${type.id} mark must not be ahead of now`).toBeLessThanOrEqual(deps.now())
    }
  })

  it('runs a job per person and listable data type', async () => {
    // mockImplementation rather than mockResolvedValue: a run spans many jobs and windows,
    // therefore many fetch calls, and a Response body can only be read once.
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
    const report = await runSync({
      personIds: ['alice', 'bob'], trailingDays: 1, userHorizonDays: DEFAULT_USER_HORIZON_DAYS, deps: build(fetchMock),
    })
    expect(report.jobs).toBeGreaterThan(0)
    expect(report.failed).toBe(0)
  })

  it('uses each person own timezone, so a household spanning zones syncs correct days', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
    await runSync({ personIds: ['alice', 'bob'], trailingDays: 1, userHorizonDays: DEFAULT_USER_HORIZON_DAYS, deps: build(fetchMock) })

    // The archive records windowStartMs per person, so the window boundaries a person actually
    // synced are checkable directly rather than inferred from an incidental filter count. Alice
    // is Europe/Amsterdam and Bob is UTC, a two hour offset in August, so their day boundaries are
    // genuinely different instants and the two sets of starts must be disjoint.
    const rows = ctx.db.select({ personId: rawPayloads.personId, windowStartMs: rawPayloads.windowStartMs })
      .from(rawPayloads).all()
    const startsFor = (personId: string) =>
      new Set(rows.filter((r) => r.personId === personId).map((r) => r.windowStartMs))
    const aliceStarts = startsFor('alice')
    const bobStarts = startsFor('bob')
    expect(aliceStarts.size).toBeGreaterThan(0)
    expect(bobStarts.size).toBeGreaterThan(0)
    for (const start of aliceStarts) expect(bobStarts.has(start)).toBe(false)
  })

  it('keeps going when one person fails, because a household is not one account', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      String(url).includes('users/me') && fetchMock.mock.calls.length === 1
        ? new Response('{"error":{"code":400}}', { status: 400 })
        : new Response(body([]), { status: 200 }))
    const report = await runSync({
      personIds: ['alice', 'bob'], trailingDays: 1, userHorizonDays: DEFAULT_USER_HORIZON_DAYS, deps: build(fetchMock),
    })
    expect(report.failed).toBeGreaterThan(0)
    expect(report.succeeded).toBeGreaterThan(0)
  })

  it('skips a person id with no row and reports it, rather than aborting the household run', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
    const report = await runSync({
      personIds: ['ghost', 'alice'], trailingDays: 1, userHorizonDays: DEFAULT_USER_HORIZON_DAYS, deps: build(fetchMock),
    })
    expect(report.unknownPersonIds).toEqual(['ghost'])
    // Alice comes after the bad id, so a throw would have cost her the whole run.
    expect(report.jobs).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('reports what it did, so a caller can show progress without reading the database', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
    const report = await runSync({ personIds: ['alice'], trailingDays: 1, userHorizonDays: DEFAULT_USER_HORIZON_DAYS, deps: build(fetchMock) })
    expect(report).toMatchObject({
      jobs: expect.any(Number), succeeded: expect.any(Number),
      failed: expect.any(Number), skipped: expect.any(Number),
    })
  })
})
