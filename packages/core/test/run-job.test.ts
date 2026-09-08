import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { SourceRegistry } from '../src/store/sources.ts'
import { SyncStateStore } from '../src/store/syncState.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { HealthClient } from '../src/api/client.ts'
import { dataTypeById } from '../src/api/catalogue.ts'
import { runJob } from '../src/sync/runJob.ts'
import { dayWindows } from '../src/sync/windows.ts'
import { RevokedError } from '../src/api/tokens.ts'
import { samplePoint, sleepPoint, body } from '../src/testing/payloads.ts'
import { observations, samples, sessions, sources, syncState } from '../src/db/schema/index.ts'
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
    // The field map records platform taking both values inside single payloads, and spec
    // invariant 4 requires every row to keep its own source. One body, two platforms, so a
    // runner that stamped one source per call could not pass this.
    const watch = {
      platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED',
      device: { displayName: 'Sense 2', formFactor: 'WATCH' },
    }
    const phone = { platform: 'HEALTH_CONNECT', recordingMethod: 'ACTIVELY_MEASURED' }
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([
      samplePoint({ payloadKey: 'oxygenSaturation', valuePath: 'percentage', value: 97, physicalTime: '2026-08-18T10:00:00Z', dataSource: watch }),
      samplePoint({ payloadKey: 'oxygenSaturation', valuePath: 'percentage', value: 95, physicalTime: '2026-08-18T11:00:00Z', dataSource: phone }),
    ]), { status: 200 }))
    await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: build(fetchMock),
    })

    const sourceRows = ctx.db.select().from(sources).all()
    expect(sourceRows.map((r) => r.displayName).sort()).toEqual(['HEALTH_CONNECT', 'Sense 2'])
    expect(sourceRows.find((r) => r.displayName === 'Sense 2')?.kind).toBe('device')
    expect(sourceRows.find((r) => r.displayName === 'HEALTH_CONNECT')?.kind).toBe('app')

    const rows = ctx.db.select().from(samples).all()
    expect(rows).toHaveLength(2)
    const sourceOf = (value: number) => rows.find((r) => r.value === value)?.sourceId
    expect(sourceOf(97)).toBe(sourceRows.find((r) => r.displayName === 'Sense 2')?.id)
    expect(sourceOf(95)).toBe(sourceRows.find((r) => r.displayName === 'HEALTH_CONNECT')?.id)
    expect(sourceOf(97)).not.toBe(sourceOf(95))
  })

  // Spec section 13 says store, log, continue. The store and the continue were there; the log
  // was not, so the one failure mode that produces no error at all produced no signal either.
  describe('schema drift', () => {
    const window = {
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
    }

    it('records drift when a window full of points maps to no rows at all', async () => {
      // Google renames the value field. Every page still arrives full, every point still parses
      // as a point, and not one of them yields a row. Before this check the job recorded plain
      // success: consecutiveFailures stayed 0, the backfill marched on to the horizon, and with
      // doctor deferred to M4 and no dashboard until M3, nothing would have said a word.
      const renamed = samplePoint({
        payloadKey: 'oxygenSaturation', valuePath: 'percentageValue', value: 97,
        physicalTime: '2026-08-18T10:00:00Z',
      })
      const fetchMock = vi.fn().mockImplementation(async () => new Response(body([renamed]), { status: 200 }))
      const deps = build(fetchMock)
      const result = await runJob({
        personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS, ...window, deps,
      })

      expect(result.points, 'the API answered with points').toBeGreaterThan(0)
      expect(result.rowsWritten, 'and none of them mapped').toBe(0)
      const state = deps.syncState.get('p1', 'oxygen-saturation')
      expect(state?.lastError).toMatch(/^\[schema_drift\]/)
      // Deliberately not a failure. The fetch worked and the archive holds every byte, so a
      // rebuild recovers this once the mapping is fixed; backing off would stop the archive
      // filling, which is the one thing still going right.
      expect(state?.consecutiveFailures, 'drift must not trip the backoff').toBe(0)
      expect(state?.lastSuccessAtMs).not.toBeNull()
    })

    it('stays quiet when the person simply has no data for the type', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
      const deps = build(fetchMock)
      await runJob({
        personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS, ...window, deps,
      })
      // No points is not drift. A type nobody records would otherwise cry wolf every single run.
      expect(deps.syncState.get('p1', 'oxygen-saturation')?.lastError ?? null).toBeNull()
    })

    it('splits active minutes into a row per activity level instead of deferring it', async () => {
      // active-minutes used to defer mapping entirely, so this test asserted zero rows written.
      // Task 11 taught mapSamples the sub-dimension, so the type is no longer deferred and this
      // now asserts the split it produces instead.
      const point = {
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        activeMinutes: {
          interval: {
            startTime: '2026-08-18T10:00:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-18T11:00:00Z', endUtcOffset: '7200s',
          },
          activeMinutesByActivityLevel: [
            { activityLevel: 'LIGHT', activeMinutes: '20' },
            { activityLevel: 'VIGOROUS', activeMinutes: '5' },
          ],
        },
      }
      const fetchMock = vi.fn().mockImplementation(async () => new Response(body([point]), { status: 200 }))
      const deps = build(fetchMock)
      // A single local day rather than the shared `window`: that one spans two AMS calendar
      // days, and the mock answers every window with the same point, which would double the
      // count and obscure that one point becomes two rows.
      const result = await runJob({
        personId: 'p1', dataType: dataTypeById('active-minutes')!, timezone: AMS,
        fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-18T22:00:00Z'), deps,
      })
      expect(result.rowsWritten).toBe(2)
      expect(deps.syncState.get('p1', 'active-minutes')?.lastError ?? null).toBeNull()
    })
  })

  it('is idempotent, so a second run over the same window changes nothing', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([spo2Point('2026-08-18T10:00:00Z', 97)]), { status: 200 }))
    const args = {
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
    }
    const shape = () => ctx.db.select().from(samples).all()
      .map((r) => ({ value: r.value, n: r.n, tzOffsetMinutes: r.tzOffsetMinutes }))

    await runJob({ ...args, deps: build(fetchMock) })
    const after = shape()
    expect(after.length).toBeGreaterThan(0)

    await runJob({ ...args, deps: build(fetchMock) })
    // Row counts alone cannot tell a correct no op from a second run whose transaction rolled
    // back on a constraint violation, since the first run's rows are still there either way.
    expect(shape()).toEqual(after)
    expect(ctx.db.select().from(sources).all().length).toBeGreaterThan(0)
    const state = ctx.db.select().from(syncState).all()[0]
    expect(state?.consecutiveFailures).toBe(0)
    expect(state?.lastError).toBeNull()
  })

  it('upserts an observation on a second sync over the same window, so a re-fetched point does not duplicate', async () => {
    // The third target, alongside the samples and sessions cases above. mapObservations derives
    // id from the natural key (person, source, type, instant, index), so a re-fetch of this same
    // window remaps to the same id on the second run - which is exactly the case a plain insert
    // cannot survive twice.
    const point = () => samplePoint({
      payloadKey: 'ovulationTest', valuePath: 'result', value: 'positive', physicalTime: '2026-08-18T10:00:00Z',
    })
    // A single local day, not the shared full-UTC-day window: that one spans two AMS calendar
    // days and would fetch (and therefore map) this same point twice on the very first sync,
    // which is a different thing from the second-sync duplication this test is checking.
    const args = {
      personId: 'p1', dataType: dataTypeById('ovulation-test')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-18T22:00:00Z'),
    }
    const rows = () => ctx.db.select().from(observations).all()

    const first = await runJob({ ...args, deps: build(vi.fn().mockImplementation(async () => new Response(body([point()]), { status: 200 }))) })
    expect(first.rowsWritten).toBe(1)
    const after = rows()
    // A count is what tells a working upsert apart from a silent duplicate; toHaveLength alone
    // is the assertion a plain-insert regression would still pass on the first sync.
    expect(after).toHaveLength(1)
    expect(after[0]).toEqual({
      id: after[0]?.id,
      personId: 'p1',
      sourceId: after[0]?.sourceId,
      kind: 'ovulation_test',
      startedAtMs: Date.parse('2026-08-18T10:00:00Z'),
      startedAtOffsetMinutes: 120,
      endedAtMs: null,
      endedAtOffsetMinutes: null,
      localDate: '2026-08-18',
      value: 'positive',
      rawPayloadId: after[0]?.rawPayloadId,
    })

    const second = await runJob({ ...args, deps: build(vi.fn().mockImplementation(async () => new Response(body([point()]), { status: 200 }))) })
    expect(second.rowsWritten).toBe(1)
    // Same window, same point, mapped to the same id: the row count must stay at one rather than
    // growing to two, and the row itself - not merely its count - must still be whole afterwards.
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toEqual(after[0])
  })

  it('fans an ECG payload out to all three tables its alsoTargets name, and marks every local date any of them wrote', async () => {
    // runJob's own dispatch used to switch on t.target alone, so a real ECG sync wrote only the
    // sessions row and silently dropped the samples row (beatsPerMinuteAvg) and the observations
    // row (resultClassification) that catalogue.ts's alsoTargets: ['samples', 'observations']
    // promises. The three mappers already honour alsoTargets on their own - see
    // catalogue-ecg.test.ts for each mapper in isolation - so this is the one test that actually
    // runs a sync and checks the database, the shape missing from the suite that let the defect
    // ship. Reading matches catalogue-ecg.test.ts's aReading fixture so a failure here points at
    // runJob's dispatch, not at a payload shape unique to this test.
    const reading = {
      name: 'users/me/dataTypes/electrocardiogram/dataPoints/reading1',
      dataSource: {
        platform: 'FITBIT', recordingMethod: 'ACTIVELY_MEASURED',
        device: { displayName: 'Sense 2', formFactor: 'WATCH' },
      },
      electrocardiogram: {
        interval: {
          startTime: '2026-08-18T09:00:00Z', startUtcOffset: '7200s',
          endTime: '2026-08-18T09:00:30Z', endUtcOffset: '7200s',
        },
        beatsPerMinuteAvg: '72',
        resultClassification: 'ATRIAL_FIBRILLATION',
        waveformSamples: Array.from({ length: 500 }, (_, i) => i % 40),
        samplingFrequencyHertz: 250,
        millivoltsScalingFactor: 1,
        leadNumber: 1,
        medicalDeviceInfo: { manufacturer: 'Acme', model: 'Watch 9' },
      },
    }
    // A single local day, the same pattern the ovulation-test upsert test above uses, so the one
    // point is fetched (and therefore mapped) exactly once rather than by two overlapping windows.
    const args = {
      personId: 'p1', dataType: dataTypeById('electrocardiogram')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-18T22:00:00Z'),
    }
    const queue = new DeriveQueue(ctx.db)
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([reading]), { status: 200 }))
    const result = await runJob({ ...args, deps: { ...build(fetchMock), deriveQueue: queue } })

    // One row per table, not merely "at least one": a mapper that quietly duplicated or a
    // dispatch that ran a writer twice would still pass a >0 check.
    expect(result.rowsWritten).toBe(3)

    const sessionRows = ctx.db.select().from(sessions).all()
    expect(sessionRows).toHaveLength(1)
    expect(sessionRows[0]).toEqual({
      id: sessionRows[0]?.id,
      personId: 'p1',
      sourceId: sessionRows[0]?.sourceId,
      kind: 'ecg',
      externalId: 'users/me/dataTypes/electrocardiogram/dataPoints/reading1',
      startMs: Date.parse('2026-08-18T09:00:00Z'),
      startOffsetMinutes: 120,
      endMs: Date.parse('2026-08-18T09:00:30Z'),
      endOffsetMinutes: 120,
      localDate: '2026-08-18',
      attrs: JSON.stringify({
        type: null, mainSleep: null, stagesStatus: null, summary: null,
        metricsSummary: null, shortAwakenings: null, exerciseType: null,
      }),
      rawPayloadId: sessionRows[0]?.rawPayloadId,
    })

    const sampleRows = ctx.db.select().from(samples).all()
    expect(sampleRows).toHaveLength(1)
    expect(sampleRows[0]).toEqual({
      personId: 'p1',
      sourceId: sampleRows[0]?.sourceId,
      metric: 'ecg_heart_rate',
      utcMs: Date.parse('2026-08-18T09:00:00Z'),
      tzOffsetMinutes: 120,
      agg: 'raw',
      value: 72,
      n: 1,
      rawPayloadId: sampleRows[0]?.rawPayloadId,
    })

    const observationRows = ctx.db.select().from(observations).all()
    expect(observationRows).toHaveLength(1)
    expect(observationRows[0]).toEqual({
      id: observationRows[0]?.id,
      personId: 'p1',
      sourceId: observationRows[0]?.sourceId,
      kind: 'ecg_classification',
      startedAtMs: Date.parse('2026-08-18T09:00:00Z'),
      startedAtOffsetMinutes: 120,
      endedAtMs: Date.parse('2026-08-18T09:00:30Z'),
      endedAtOffsetMinutes: 120,
      localDate: '2026-08-18',
      value: 'ATRIAL_FIBRILLATION',
      rawPayloadId: observationRows[0]?.rawPayloadId,
    })

    // All three writers land the same instant on the same local date here, but the point of
    // merging localDates rather than keeping only the primary writer's is that they need not:
    // a future alsoTargets type whose extra writer's row falls on a different local date (an
    // overnight session paired with a same-instant observation, say) would otherwise leave that
    // date unmarked, and runDerive would never refresh it.
    expect(queue.claim(10).map((e) => e.localDate)).toEqual(['2026-08-18'])
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

  it('marks the day a session left as well as the day it moved to', async () => {
    // A session that moved days leaves derived rows behind on the day it left. localDate is in
    // the upsert's set clause, so a corrected end offset legitimately moves one across midnight,
    // and the delete-then-insert that rewrites a day's sleep rows only runs for a dirty day.
    const night = (utcOffset: string) => body([sleepPoint({
      startTime: '2026-08-18T21:00:00Z', endTime: '2026-08-18T22:30:00Z', utcOffset,
      stages: [{ type: 'DEEP', startTime: '2026-08-18T21:00:00Z', endTime: '2026-08-18T22:30:00Z' }],
    })])
    const args = {
      personId: 'p1', dataType: dataTypeById('sleep')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
    }
    const queue = new DeriveQueue(ctx.db)
    const deps = (utcOffset: string) => ({
      ...build(vi.fn().mockImplementation(async () => new Response(night(utcOffset), { status: 200 }))),
      deriveQueue: queue,
    })

    await runJob({ ...args, deps: deps('7200s') })
    expect(queue.claim(10).map((e) => e.localDate)).toEqual(['2026-08-19'])
    queue.clear(queue.claim(10))

    // The same session, one hour earlier, which puts its end on the previous local date.
    await runJob({ ...args, deps: deps('3600s') })
    expect(ctx.db.select().from(sessions).all()[0]?.localDate).toBe('2026-08-18')
    expect(queue.claim(10).map((e) => e.localDate).sort()).toEqual(['2026-08-18', '2026-08-19'])
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
    // active-zone-minutes was the deferred type this test used to exercise; task 11 gave it a
    // mapping, so nutrition-log, the one type still deferred, stands in for it here.
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([]), { status: 200 }))
    const result = await runJob({
      personId: 'p1', dataType: dataTypeById('nutrition-log')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: build(fetchMock),
    })
    expect(result.rowsWritten).toBe(0)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('marks every day it wrote rows into, in the transaction that wrote them', async () => {
    // Each window is answered with a point an hour into the day it asked for, so every window
    // writes a row of its own local day and the marked set can be checked against dayWindows
    // exactly, rather than merely asserting the queue is non-empty.
    const args = {
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-17T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
    }
    const windows = dayWindows({ fromMs: args.fromMs, toMs: args.toMs, timezone: args.timezone })
    let next = 0
    const fetchMock = vi.fn().mockImplementation(async () => {
      const window = windows[next++]!
      return new Response(body([spo2Point(new Date(window.startMs + 3_600_000).toISOString(), 97)]), { status: 200 })
    })
    const queue = new DeriveQueue(ctx.db)
    const result = await runJob({ ...args, deps: { ...build(fetchMock), deriveQueue: queue } })

    const expectedDates = windows.map((w) => w.localDate)
    expect(result.windows).toBe(expectedDates.length)
    expect(result.rowsWritten).toBeGreaterThan(0)

    const entries = queue.claim(expectedDates.length + 1)
    expect(entries).toHaveLength(expectedDates.length)
    expect(entries.every((e) => e.personId === 'p1')).toBe(true)
    expect(entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.localDate))).toBe(true)
    expect(entries.map((e) => e.localDate).sort()).toEqual([...expectedDates].sort())
  })

  it('marks the day a row belongs to, not the day the window asked for', async () => {
    // A person who travelled. The window is built in their home timezone, but this point
    // carries its own offset, eleven hours behind, which puts it on the previous local day -
    // and runDerive selects a day's rows by each row's own offset. Marking the window's date
    // would leave that day unmarked and its rows carrying a value no later run corrects.
    const abroad = samplePoint({
      payloadKey: 'oxygenSaturation', valuePath: 'percentage', value: 97,
      physicalTime: '2026-08-18T00:30:00Z', utcOffset: '-39600s',
    })
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([abroad]), { status: 200 }))
    const queue = new DeriveQueue(ctx.db)
    await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'),
      deps: { ...build(fetchMock), deriveQueue: queue },
    })

    expect(queue.claim(10).map((e) => e.localDate)).toEqual(['2026-08-17'])
  })

  it('rolls the rows back with the mark, so a failed mark never leaves rows behind for a day the queue does not know is dirty', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(body([spo2Point('2026-08-18T10:00:00Z', 97)]), { status: 200 }))
    const queue = new DeriveQueue(ctx.db)
    const deps = { ...build(fetchMock), deriveQueue: queue }

    // The sample rows map and insert cleanly; only the mark that follows them fails. That is
    // what makes the empty samples table below meaningful: those rows were written before the
    // trigger fired, so their absence afterwards proves the day's mark and the day's rows commit
    // or roll back together, not merely that a doomed write leaves nothing queued.
    ctx.db.$client.exec("CREATE TRIGGER haelan_test_queue_fail BEFORE INSERT ON derive_queue BEGIN SELECT RAISE(ABORT, 'derive_queue insert failed'); END")
    const result = await runJob({
      personId: 'p1', dataType: dataTypeById('oxygen-saturation')!, timezone: AMS,
      fromMs: Date.parse('2026-08-18T00:00:00Z'), toMs: Date.parse('2026-08-19T00:00:00Z'), deps,
    })
    ctx.db.$client.exec('DROP TRIGGER haelan_test_queue_fail')

    expect(result.rowsWritten).toBe(0)
    expect(queue.size()).toBe(0)
    expect(ctx.db.select().from(samples).where(eq(samples.personId, 'p1')).all()).toHaveLength(0)
  })
  it('withholds the high-water mark when a window came back unreadable', async () => {
    // The list half of the same defect. A renamed dataPoints array counted zero points and
    // wrote no rows, which is what a quiet day looks like, so the mark advanced over it. Sample
    // level history is the part that cannot be recovered later: the API only retains intraday
    // data for a recent window, so a day scrolled past is gone at that resolution.
    const renamed = JSON.stringify({ dataPointList: [{ a: 1 }] })
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () => new Response(renamed, { status: 200 }),
    )
    const deps = build(fetchMock)
    const result = await runJob({
      personId: 'p1', dataType: dataTypeById('steps')!, timezone: AMS,
      fromMs: Date.UTC(2026, 7, 18), toMs: Date.UTC(2026, 7, 19), deps,
    })

    expect(result.unreadableWindows).toBeGreaterThan(0)
    expect(deps.syncState.get('p1', 'steps')?.highWaterMs ?? null).toBeNull()
    expect(deps.syncState.get('p1', 'steps')?.lastError).toContain('unreadable')
  })

  it('still stamps the mark for a window that was simply quiet', async () => {
    // The other side of it. An empty body is an ordinary answer and must not stall the cursor,
    // or a person with a quiet day would never sync past it.
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    )
    const deps = build(fetchMock)
    const result = await runJob({
      personId: 'p1', dataType: dataTypeById('steps')!, timezone: AMS,
      fromMs: Date.UTC(2026, 7, 18), toMs: Date.UTC(2026, 7, 19), deps,
    })

    expect(result.unreadableWindows).toBe(0)
    expect(deps.syncState.get('p1', 'steps')?.highWaterMs).toBeGreaterThan(0)
  })

})
