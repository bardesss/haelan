import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { runDerive } from '../src/derive/runDerive.ts'
import { SourcePriorityStore } from '../src/store/sourcePriority.ts'
import { OverrideStore } from '../src/store/overrides.ts'
import { sampleTarget, dayMetricTarget } from '../src/derive/targetKey.ts'
import { daily, samples, sources } from '../src/db/schema/index.ts'

const OFFSET = 120
const MIDNIGHT_UTC = Date.UTC(2026, 7, 21, 22, 0)
const LOCAL_DATE = '2026-08-22'

let test: TestDatabase
let queue: DeriveQueue
let priority: SourcePriorityStore
let overrideStore: OverrideStore
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  for (const id of ['watch', 'phone']) {
    test.db.insert(sources).values({
      id, personId: 'p1', externalId: id, displayName: id, kind: 'device', createdAtMs: 0,
    }).run()
  }
  queue = new DeriveQueue(test.db)
  priority = new SourcePriorityStore(test.db, queue)
  overrideStore = new OverrideStore(test.db, queue)
})
afterEach(() => test.cleanup())

const insertSample = (o: { metric: string, value: number, hour: number, sourceId?: string, tzOffsetMinutes?: number }) =>
  test.db.insert(samples).values({
    personId: 'p1', sourceId: o.sourceId ?? 'watch', metric: o.metric,
    utcMs: MIDNIGHT_UTC + o.hour * 3_600_000, tzOffsetMinutes: o.tzOffsetMinutes ?? OFFSET,
    agg: 'raw', value: o.value, n: 1, rawPayloadId: null,
  }).run()

const dailyRows = () => test.db.select().from(daily).where(eq(daily.personId, 'p1')).all()
const perSourceRows = () => dailyRows().filter((r) => r.source !== 'merged' && r.source !== 'provider')
const mergedRows = () => dailyRows().filter((r) => r.source === 'merged')

describe('runDerive', () => {
  it('derives a queued day and clears it', () => {
    insertSample({ metric: 'steps', value: 400, hour: 9 })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    const report = runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(report.daysDerived).toBe(1)
    expect(queue.size()).toBe(0)
    expect(perSourceRows().map((r) => [r.metric, r.agg, r.value])).toEqual([['steps', 'sum', 400]])
  })

  it('is idempotent: draining twice writes the same rows, not twice the rows', () => {
    insertSample({ metric: 'steps', value: 400, hour: 9 })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 2 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    // One per source row and one merged row. Draining twice is still one of each.
    expect(dailyRows()).toHaveLength(2)
  })

  it('removes a row whose samples went away, rather than leaving a stale number', () => {
    // An override that excludes the only sample of a day has to leave the day empty, not
    // leave yesterday's answer standing.
    insertSample({ metric: 'steps', value: 400, hour: 9 })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    test.db.delete(samples).run()
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 2 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(dailyRows()).toEqual([])
  })

  it('leaves provider rows alone, because nothing here derives them', () => {
    test.db.insert(daily).values({
      personId: 'p1', localDate: LOCAL_DATE, metric: 'total_calories', agg: 'sum',
      source: 'provider', value: 2500, coverage: null, derivationVersion: 1,
    }).run()
    insertSample({ metric: 'steps', value: 400, hour: 9 })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(dailyRows().filter((r) => r.source === 'provider')).toHaveLength(1)
  })

  it('reads only the queued day, not the ones either side of it', () => {
    insertSample({ metric: 'steps', value: 400, hour: 9 })
    insertSample({ metric: 'steps', value: 999, hour: 30 })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(perSourceRows().map((r) => r.value)).toEqual([400])
  })

  it('keeps a source split rather than adding two devices together', () => {
    insertSample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' })
    insertSample({ metric: 'steps', value: 900, hour: 9, sourceId: 'phone' })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(perSourceRows().map((r) => r.value).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([400, 900])
  })

  it('stops at the batch size and leaves the rest queued', () => {
    for (const localDate of ['2026-08-20', '2026-08-21', '2026-08-22']) {
      queue.markDirty({ personId: 'p1', localDate, nowMs: 1 })
    }
    const report = runDerive({ db: test.db, queue, priority, overrides: overrideStore, batch: 2 })
    expect(report.daysDerived).toBe(2)
    expect(queue.size()).toBe(1)
  })

  it('includes a sample at the UTC-12 extreme, at the far end of the same widened window', () => {
    // The other edge of the widened query, and the one nothing held. runDerive anchors on
    // 2026-08-22T00:00Z for LOCAL_DATE; at tz -720 (UTC-12) that local day does not end until
    // 2026-08-23T12:00Z, nearly 36 hours past the anchor. Cutting the +38 hour upper bound to
    // +24 leaves every other test in this file green and drops this row silently.
    test.db.insert(samples).values({
      personId: 'p1', sourceId: 'watch', metric: 'steps',
      utcMs: Date.UTC(2026, 7, 23, 11, 59), tzOffsetMinutes: -720,
      agg: 'raw', value: 222, n: 1, rawPayloadId: null,
    }).run()
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(perSourceRows().map((r) => r.value)).toEqual([222])
  })

  it('includes a sample at the UTC+14 extreme whose local date still falls on the queued day', () => {
    // UTC midnight for LOCAL_DATE is 2026-08-21T22:00Z. At tz +840 (UTC+14), an instant at
    // 2026-08-21T10:05Z is already 2026-08-22 locally, 11h55m before that UTC midnight and
    // outside a naive same-day scan. The bounded query in runDerive must widen far enough
    // (14h before midnight) to still catch it, or this row would silently vanish.
    test.db.insert(samples).values({
      personId: 'p1', sourceId: 'watch', metric: 'steps',
      utcMs: Date.UTC(2026, 7, 21, 10, 5), tzOffsetMinutes: 840,
      agg: 'raw', value: 111, n: 1, rawPayloadId: null,
    }).run()
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(perSourceRows().map((r) => r.value)).toEqual([111])
  })

  it('writes a merged row beside the per source rows, never instead of them', () => {
    // Invariant 4: merging never happens on write. The per source rows are what a merge is
    // inspected against, so a merged row that replaced them would destroy its own evidence.
    insertSample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' })
    insertSample({ metric: 'steps', value: 900, hour: 15, sourceId: 'phone' })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })

    expect(perSourceRows().map((r) => r.value).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([400, 900])
    const merged = mergedRows()
    expect(merged).toHaveLength(1)
    expect(merged[0]?.value).toBe(1300)
    // encodeMix breaks a tie in hours by source id ascending, so 'phone' sorts before 'watch'.
    expect(merged[0]?.sourceMix).toBe('[{"source":"phone","hours":1},{"source":"watch","hours":1}]')
  })

  it('follows a stored priority list rather than the fallback', () => {
    insertSample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' })
    insertSample({ metric: 'steps', value: 900, hour: 9, sourceId: 'phone' })
    priority.put({ personId: 'p1', metric: 'steps', sourceIds: ['phone', 'watch'], nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(mergedRows()[0]?.value).toBe(900)
  })

  it('replaces a merged row wholesale, so a stale merge cannot outlive its inputs', () => {
    insertSample({ metric: 'steps', value: 400, hour: 9, sourceId: 'watch' })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    test.db.delete(samples).run()
    insertSample({ metric: 'steps', value: 50, hour: 9, sourceId: 'watch' })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 2 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(mergedRows().map((r) => r.value)).toEqual([50])
  })

  it('excludes an overridden reading from both the per source row and the merged one', () => {
    insertSample({ metric: 'heart_rate', value: 210, hour: 9 })
    insertSample({ metric: 'heart_rate', value: 60, hour: 10 })
    overrideStore.put({
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: MIDNIGHT_UTC + 9 * 3_600_000 }),
      action: 'exclude', reason: 'strap glitch', nowMs: 1,
    })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })

    expect(perSourceRows().find((r) => r.agg === 'max')?.value).toBe(60)
    expect(mergedRows().find((r) => r.agg === 'max')?.value).toBe(60)
  })

  it('restores the original exactly when the override is removed', () => {
    // The point of applying at derivation: tier 1 was never modified, so removal is not a repair.
    insertSample({ metric: 'heart_rate', value: 210, hour: 9 })
    insertSample({ metric: 'heart_rate', value: 60, hour: 10 })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    const before = dailyRows()

    const id = overrideStore.put({
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: MIDNIGHT_UTC + 9 * 3_600_000 }),
      action: 'exclude', reason: 'strap glitch', nowMs: 2,
    })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(dailyRows()).not.toEqual(before)

    overrideStore.remove({ personId: 'p1', id, nowMs: 3 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(dailyRows()).toEqual(before)
  })

  it('substitutes a corrected reading', () => {
    insertSample({ metric: 'weight', value: 205, hour: 9 })
    overrideStore.put({
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'weight', utcMs: MIDNIGHT_UTC + 9 * 3_600_000 }),
      action: 'correct', correctedValue: 80.5, reason: 'pounds, not kilos', nowMs: 1,
    })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(perSourceRows().find((r) => r.agg === 'last')?.value).toBe(80.5)
  })

  it('drops a day_metric exclusion from every row for that metric, provider rows included', () => {
    test.db.insert(daily).values({
      personId: 'p1', localDate: LOCAL_DATE, metric: 'total_calories', agg: 'sum',
      source: 'provider', value: 2500, coverage: null, sourceMix: null, derivationVersion: 1,
    }).run()
    insertSample({ metric: 'steps', value: 400, hour: 9 })
    overrideStore.put({
      personId: 'p1', scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: LOCAL_DATE, metric: 'total_calories' }),
      action: 'exclude', reason: 'device was on the dog', nowMs: 1,
    })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })

    expect(dailyRows().filter((r) => r.metric === 'total_calories')).toEqual([])
    expect(dailyRows().filter((r) => r.metric === 'steps').length).toBeGreaterThan(0)
  })

  it('leaves another day of the same metric alone', () => {
    insertSample({ metric: 'steps', value: 400, hour: 9 })
    overrideStore.put({
      personId: 'p1', scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-08-21', metric: 'steps' }),
      action: 'exclude', reason: 'yesterday', nowMs: 1,
    })
    queue.markDirty({ personId: 'p1', localDate: LOCAL_DATE, nowMs: 1 })
    runDerive({ db: test.db, queue, priority, overrides: overrideStore })
    expect(perSourceRows().map((r) => r.value)).toEqual([400])
  })
})
