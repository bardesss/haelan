import { and, eq, inArray } from 'drizzle-orm'
import { describe, it, expect } from 'vitest'
import { createTestDatabase, seedPerson, seedSession, readSamples } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { CompanionRecords, uncovered } from '../src/store/companionRecords.ts'
import { SampleKeys } from '../src/db/keys.ts'
import { samples, sources, sessions, companionDeletions, companionRecordSamples } from '../src/db/schema/index.ts'
import { dataTypeById } from '../src/api/catalogue.ts'
import { downsampleToMinute } from '../src/api/downsample.ts'
import type { SampleRow } from '../src/api/mapSamples.ts'

describe('companion record links and tombstones', () => {
  it('the latest migration creates the record link and tombstone tables', () => {
    const ctx = createTestDatabase()
    const names = ctx.db.$client.prepare("select name from sqlite_master where type = 'table'").all()
      .map((r) => (r as { name: string }).name)
    expect(names).toEqual(expect.arrayContaining(['companion_record_samples', 'companion_deletions']))
    ctx.cleanup()
  })
})

const WEIGHT = dataTypeById('weight')!
const HEART_RATE = dataTypeById('heart-rate')!
const SLEEP = dataTypeById('sleep')!
const T0 = Date.parse('2026-08-18T07:00:00Z')

function tombstones(ctx: TestDatabase, ids: readonly string[]): Set<string> {
  const found = new Set<string>()
  for (let i = 0; i < ids.length; i += 500) {
    for (const r of ctx.db.select({ recordId: companionDeletions.recordId }).from(companionDeletions)
      .where(and(eq(companionDeletions.personId, 'p1'), inArray(companionDeletions.recordId, ids.slice(i, i + 500))))
      .all()) found.add(r.recordId)
  }
  return found
}

function row(over: Partial<SampleRow>): SampleRow {
  return {
    personId: 'p1', sourceId: 'phone', metric: 'weight', utcMs: T0, tzOffsetMinutes: 120,
    agg: 'raw', value: 80, n: 1, rawPayloadId: 'x', ...over,
  }
}

// Stores rows and their links the way ingest will: through sampleRefs, then link.
function store(ctx: TestDatabase, rows: SampleRow[], withLinks = true): void {
  const { db } = ctx
  for (const sourceId of new Set(rows.map((r) => r.sourceId))) {
    db.insert(sources).values({
      id: sourceId, personId: 'p1', externalId: sourceId, displayName: sourceId, kind: 'device', createdAtMs: 0,
    }).onConflictDoNothing().run()
  }
  const keys = new SampleKeys(db)
  // An upsert on the natural key, as ingest writes: a second record on the same key overwrites.
  for (const r of rows) {
    const stored = keys.sampleRefs({ ...r, rawPayloadId: null })
    db.insert(samples).values(stored).onConflictDoUpdate({
      target: [samples.personRef, samples.sourceRef, samples.metricRef, samples.utcMs, samples.aggRef],
      set: { value: stored.value, n: stored.n },
    }).run()
  }
  if (withLinks) new CompanionRecords(db).link('p1', rows, keys)
}

describe('CompanionRecords', () => {
  it('deleting a weight by record id removes its row and names its day', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    store(ctx, [row({ recordId: 'hc-weight-1' })])
    store(ctx, [row({ utcMs: T0 + 3_600_000, value: 81 })], false)
    const keys = new SampleKeys(ctx.db)
    const out = new CompanionRecords(ctx.db)
      .deleteRecords({ personId: 'p1', dataType: WEIGHT, recordIds: ['hc-weight-1'], nowMs: 5 }, keys)
    expect(out).toEqual({ rowsDeleted: 1, localDates: ['2026-08-18'] })
    expect(readSamples(ctx.db).map((r) => r.value)).toEqual([81])
    expect(ctx.db.select().from(companionRecordSamples).all()).toEqual([])
    ctx.cleanup()
  })

  it('deleting a heart-rate record removes every aggregate of every minute it covered', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const rows = downsampleToMinute([
      row({ metric: 'heart_rate', utcMs: T0, value: 60, recordId: 'hc-hr-1' }),
      row({ metric: 'heart_rate', utcMs: T0 + 60_000, value: 70, recordId: 'hc-hr-1' }),
    ])
    store(ctx, rows)
    const out = new CompanionRecords(ctx.db).deleteRecords(
      { personId: 'p1', dataType: HEART_RATE, recordIds: ['hc-hr-1'], nowMs: 5 }, new SampleKeys(ctx.db))
    expect(out.rowsDeleted).toBe(8)
    expect(readSamples(ctx.db)).toEqual([])
    ctx.cleanup()
  })

  it('a record linked in two uploads keeps the range of both', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const minute = (offset: number) => downsampleToMinute([
      row({ metric: 'heart_rate', utcMs: T0 + offset, value: 60, recordId: 'hc-hr-1' }),
    ])
    store(ctx, minute(0))
    store(ctx, minute(10 * 60_000))
    const out = new CompanionRecords(ctx.db).deleteRecords(
      { personId: 'p1', dataType: HEART_RATE, recordIds: ['hc-hr-1'], nowMs: 5 }, new SampleKeys(ctx.db))
    expect(out.rowsDeleted).toBe(8)
    expect(readSamples(ctx.db)).toEqual([])
    ctx.cleanup()
  })

  it('a record whose earlier chunk arrives second keeps the range of both', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const minute = (offset: number) => downsampleToMinute([
      row({ metric: 'heart_rate', utcMs: T0 + offset, value: 60, recordId: 'hc-hr-1' }),
    ])
    store(ctx, minute(10 * 60_000))
    store(ctx, minute(0))
    const out = new CompanionRecords(ctx.db).deleteRecords(
      { personId: 'p1', dataType: HEART_RATE, recordIds: ['hc-hr-1'], nowMs: 5 }, new SampleKeys(ctx.db))
    expect(out.rowsDeleted).toBe(8)
    expect(readSamples(ctx.db)).toEqual([])
    ctx.cleanup()
  })

  it('another source in the same range survives the delete', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    store(ctx, [row({ recordId: 'hc-weight-1' })])
    store(ctx, [row({ sourceId: 'scale', value: 82 })], false)
    new CompanionRecords(ctx.db).deleteRecords(
      { personId: 'p1', dataType: WEIGHT, recordIds: ['hc-weight-1'], nowMs: 5 }, new SampleKeys(ctx.db))
    expect(readSamples(ctx.db).map((r) => [r.sourceId, r.value])).toEqual([['scale', 82]])
    ctx.cleanup()
  })

  it('deletes ids beyond the first chunk of 500', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    store(ctx, [row({ recordId: 'hc-weight-500' })])
    const ids = Array.from({ length: 501 }, (_, i) => `hc-weight-${i}`)
    const records = new CompanionRecords(ctx.db)
    const out = records.deleteRecords(
      { personId: 'p1', dataType: WEIGHT, recordIds: ids, nowMs: 5 }, new SampleKeys(ctx.db))
    expect(out.rowsDeleted).toBe(1)
    expect(readSamples(ctx.db)).toEqual([])
    expect(tombstones(ctx, ids).size).toBe(501)
    ctx.cleanup()
  })

  it('deleting a night removes the session by its external id', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    seedSession(ctx.db, { id: 's1', personId: 'p1', kind: 'sleep', externalId: 'hc-night-1' })
    ctx.db.update(sessions).set({ localDate: '2026-08-18' }).where(eq(sessions.id, 's1')).run()
    seedSession(ctx.db, { id: 's2', personId: 'p1', kind: 'sleep', externalId: 'hc-night-2' })
    const out = new CompanionRecords(ctx.db).deleteRecords(
      { personId: 'p1', dataType: SLEEP, recordIds: ['hc-night-1'], nowMs: 5 }, new SampleKeys(ctx.db))
    expect(out).toEqual({ rowsDeleted: 1, localDates: ['2026-08-18'] })
    expect(ctx.db.select({ id: sessions.id }).from(sessions).all()).toEqual([{ id: 's2' }])
    ctx.cleanup()
  })

  it('records a tombstone even for a record it never saw', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const records = new CompanionRecords(ctx.db)
    const out = records.deleteRecords(
      { personId: 'p1', dataType: WEIGHT, recordIds: ['hc-unknown'], nowMs: 5 }, new SampleKeys(ctx.db))
    expect(out).toEqual({ rowsDeleted: 0, localDates: [] })
    expect(tombstones(ctx, ['hc-unknown', 'other'])).toEqual(new Set(['hc-unknown']))
    ctx.cleanup()
  })

  it('a delete keeps the row a surviving record wrote on the same key', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    store(ctx, [row({ recordId: 'hc-weight-a' })])
    store(ctx, [row({ recordId: 'hc-weight-b', value: 81 })])
    const out = new CompanionRecords(ctx.db).deleteRecords(
      { personId: 'p1', dataType: WEIGHT, recordIds: ['hc-weight-a'], nowMs: 5 }, new SampleKeys(ctx.db))
    expect(out).toEqual({ rowsDeleted: 0, localDates: [] })
    expect(readSamples(ctx.db).map((r) => r.value)).toEqual([81])
    expect(ctx.db.select().from(companionRecordSamples).all().map((l) => l.recordId)).toEqual(['hc-weight-b'])
    ctx.cleanup()
  })

  it('a heart-rate delete keeps only the minutes a surviving record also covers', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    store(ctx, downsampleToMinute([
      row({ metric: 'heart_rate', utcMs: T0, value: 60, recordId: 'hc-hr-a' }),
      row({ metric: 'heart_rate', utcMs: T0 + 60_000, value: 70, recordId: 'hc-hr-a' }),
    ]))
    store(ctx, downsampleToMinute([
      row({ metric: 'heart_rate', utcMs: T0 + 60_000, value: 70, recordId: 'hc-hr-b' }),
    ]))
    const out = new CompanionRecords(ctx.db).deleteRecords(
      { personId: 'p1', dataType: HEART_RATE, recordIds: ['hc-hr-a'], nowMs: 5 }, new SampleKeys(ctx.db))
    expect(out.rowsDeleted).toBe(4)
    expect(new Set(readSamples(ctx.db).map((r) => r.utcMs))).toEqual(new Set([T0 + 60_000]))
    ctx.cleanup()
  })

  it('a delete of two records on one key removes the row, since neither survives', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    store(ctx, [row({ recordId: 'hc-weight-a' })])
    store(ctx, [row({ recordId: 'hc-weight-b', value: 81 })])
    const out = new CompanionRecords(ctx.db).deleteRecords(
      { personId: 'p1', dataType: WEIGHT, recordIds: ['hc-weight-a', 'hc-weight-b'], nowMs: 5 }, new SampleKeys(ctx.db))
    expect(out).toEqual({ rowsDeleted: 1, localDates: ['2026-08-18'] })
    expect(readSamples(ctx.db)).toEqual([])
    ctx.cleanup()
  })

  it('a weight moved at the source no longer covers the days between its old and new time', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const day = 86_400_000
    store(ctx, [row({ recordId: 'hc-weight-moved' })])
    store(ctx, [row({ recordId: 'hc-weight-moved', utcMs: T0 + 4 * day })])
    store(ctx, [row({ recordId: 'hc-weight-between', utcMs: T0 + 2 * day, value: 81 })])
    new CompanionRecords(ctx.db).deleteRecords(
      { personId: 'p1', dataType: WEIGHT, recordIds: ['hc-weight-between'], nowMs: 5 }, new SampleKeys(ctx.db))
    expect(readSamples(ctx.db).map((r) => r.utcMs)).not.toContain(T0 + 2 * day)
    ctx.cleanup()
  })

  it('a weight moved at the source takes its old row with it and names the old day', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const day = 86_400_000
    store(ctx, [row({ recordId: 'hc-weight-moved' })])
    const keys = new SampleKeys(ctx.db)
    const moved = [row({ recordId: 'hc-weight-moved', utcMs: T0 + 4 * day })]
    store(ctx, moved, false)
    const out = new CompanionRecords(ctx.db).link('p1', moved, keys)
    expect(readSamples(ctx.db).map((r) => r.utcMs)).toEqual([T0 + 4 * day])
    expect(out).toEqual({ rowsDeleted: 1, localDates: ['2026-08-18'] })
    // So a later delete of the record leaves nothing behind.
    new CompanionRecords(ctx.db).deleteRecords(
      { personId: 'p1', dataType: WEIGHT, recordIds: ['hc-weight-moved'], nowMs: 5 }, keys)
    expect(readSamples(ctx.db)).toEqual([])
    ctx.cleanup()
  })

  it('a moved weight keeps the old row a live record of the same source still covers', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const day = 86_400_000
    store(ctx, [row({ recordId: 'hc-weight-moved' })])
    store(ctx, [row({ recordId: 'hc-weight-other', value: 81 })])
    const keys = new SampleKeys(ctx.db)
    const moved = [row({ recordId: 'hc-weight-moved', utcMs: T0 + 4 * day })]
    store(ctx, moved, false)
    expect(new CompanionRecords(ctx.db).link('p1', moved, keys)).toEqual({ rowsDeleted: 0, localDates: [] })
    expect(readSamples(ctx.db).map((r) => [r.utcMs, r.value])).toEqual([[T0, 81], [T0 + 4 * day, 80]])
    ctx.cleanup()
  })

  it('a moved weight whose stored link is wider than one instant deletes nothing', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const day = 86_400_000
    // A link widened before 2.24.0, when every metric's link widened: it spans Monday to
    // Wednesday, and a row between them may belong to a record with no link at all.
    store(ctx, [row({ recordId: 'hc-weight-old' }), row({ recordId: 'hc-weight-old', utcMs: T0 + 2 * day })])
    store(ctx, [row({ utcMs: T0 + day, value: 81 })], false)
    const keys = new SampleKeys(ctx.db)
    expect(ctx.db.select().from(companionRecordSamples).all()).toMatchObject([{ firstUtcMs: T0, lastUtcMs: T0 + 2 * day }])
    const moved = [row({ recordId: 'hc-weight-old', utcMs: T0 + 4 * day })]
    store(ctx, moved, false)
    expect(new CompanionRecords(ctx.db).link('p1', moved, keys)).toEqual({ rowsDeleted: 0, localDates: [] })
    expect(readSamples(ctx.db).map((r) => r.utcMs)).toEqual([T0, T0 + day, T0 + 2 * day, T0 + 4 * day])
    ctx.cleanup()
  })

  it('a heart-rate record widens and deletes nothing when a chunk is sent again', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const minute = (offset: number) => downsampleToMinute([
      row({ metric: 'heart_rate', utcMs: T0 + offset, value: 60, recordId: 'hc-hr-1' }),
    ])
    store(ctx, minute(0))
    const keys = new SampleKeys(ctx.db)
    const records = new CompanionRecords(ctx.db)
    store(ctx, minute(10 * 60_000), false)
    expect(records.link('p1', minute(10 * 60_000), keys)).toEqual({ rowsDeleted: 0, localDates: [] })
    store(ctx, minute(0), false)
    expect(records.link('p1', minute(0), keys)).toEqual({ rowsDeleted: 0, localDates: [] })
    expect(ctx.db.select().from(companionRecordSamples).all())
      .toMatchObject([{ firstUtcMs: T0, lastUtcMs: T0 + 10 * 60_000 }])
    expect(new Set(readSamples(ctx.db).map((r) => r.utcMs))).toEqual(new Set([T0, T0 + 10 * 60_000]))
    ctx.cleanup()
  })

  it('re-applying a tombstone keeps the row a surviving record wrote on the same key', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const records = new CompanionRecords(ctx.db)
    records.deleteRecords(
      { personId: 'p1', dataType: WEIGHT, recordIds: ['hc-weight-a'], nowMs: 5 }, new SampleKeys(ctx.db))
    store(ctx, [row({ recordId: 'hc-weight-a' })])
    store(ctx, [row({ recordId: 'hc-weight-b', value: 81 })])
    const out = records.reapplyDeletions('p1', new SampleKeys(ctx.db))
    expect(out).toEqual({ rowsDeleted: 0, localDates: [] })
    expect(readSamples(ctx.db).map((r) => r.value)).toEqual([81])
    ctx.cleanup()
  })

  it('lifting a tombstone forgets it, beyond the first chunk of 500 too', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const records = new CompanionRecords(ctx.db)
    const ids = Array.from({ length: 501 }, (_, i) => `hc-weight-${i}`)
    records.deleteRecords({ personId: 'p1', dataType: WEIGHT, recordIds: ids, nowMs: 5 }, new SampleKeys(ctx.db))
    records.lift('p1', ids)
    expect(tombstones(ctx, ids).size).toBe(0)
    ctx.cleanup()
  })

  it('a lifted tombstone is not re-applied', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const records = new CompanionRecords(ctx.db)
    records.deleteRecords(
      { personId: 'p1', dataType: WEIGHT, recordIds: ['hc-weight-1'], nowMs: 5 }, new SampleKeys(ctx.db))
    records.lift('p1', ['hc-weight-1'])
    store(ctx, [row({ recordId: 'hc-weight-1' })])
    expect(records.reapplyDeletions('p1', new SampleKeys(ctx.db))).toEqual({ rowsDeleted: 0, localDates: [] })
    expect(readSamples(ctx.db)).toHaveLength(1)
    ctx.cleanup()
  })

  it('deleting a night leaves a workout that shares its external id', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    seedSession(ctx.db, { id: 's1', personId: 'p1', kind: 'sleep', externalId: 'hc-shared' })
    seedSession(ctx.db, { id: 's2', personId: 'p1', kind: 'exercise', externalId: 'hc-shared' })
    const out = new CompanionRecords(ctx.db).deleteRecords(
      { personId: 'p1', dataType: SLEEP, recordIds: ['hc-shared'], nowMs: 5 }, new SampleKeys(ctx.db))
    expect(out.rowsDeleted).toBe(1)
    expect(ctx.db.select({ id: sessions.id }).from(sessions).all()).toEqual([{ id: 's2' }])
    ctx.cleanup()
  })

  it('re-applies tombstones without writing new ones', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    const records = new CompanionRecords(ctx.db)
    store(ctx, [row({ recordId: 'hc-weight-1' })])
    records.deleteRecords(
      { personId: 'p1', dataType: WEIGHT, recordIds: ['hc-weight-1'], nowMs: 5 }, new SampleKeys(ctx.db))
    store(ctx, [row({ recordId: 'hc-weight-1' })])
    const out = records.reapplyDeletions('p1', new SampleKeys(ctx.db))
    expect(out).toEqual({ rowsDeleted: 1, localDates: ['2026-08-18'] })
    expect(readSamples(ctx.db)).toEqual([])
    expect(ctx.db.select().from(companionDeletions).all()).toHaveLength(1)
    ctx.cleanup()
  })

  // A range delete once asked, for every candidate row, whether any live link covered it, and that
  // scanned the whole link table per row: 200 heart-rate records took minutes inside the deletions
  // route's write transaction. The bound is generous for a loaded machine; the scan blows it many
  // times over.
  it('deleting 200 heart-rate records among thousands of links stays fast', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    store(ctx, [row({ metric: 'heart_rate', recordId: 'seed' })])
    const keys = new SampleKeys(ctx.db)
    const ref = keys.sampleRefs({ ...row({ metric: 'heart_rate' }), rawPayloadId: null })
    const client = ctx.db.$client
    const insertSample = client.prepare(`insert or ignore into samples
      (person_ref, source_ref, metric_ref, utc_ms, tz_offset_minutes, agg_ref, value, n)
      values (?, ?, ?, ?, 120, ?, 60, 1)`)
    const insertLink = client.prepare(`insert into companion_record_samples
      (person_ref, record_id, source_ref, metric_ref, first_utc_ms, last_utc_ms) values (?, ?, ?, ?, ?, ?)`)
    const LINKS = 5000
    const HOUR = 3_600_000
    client.transaction(() => {
      for (let i = 0; i < LINKS; i++) {
        const first = T0 + (i + 1) * HOUR
        for (let m = 0; m < 60; m++) {
          insertSample.run(ref.personRef, ref.sourceRef, ref.metricRef, first + m * 60_000, ref.aggRef)
        }
        insertLink.run(ref.personRef, `hc-hr-${i}`, ref.sourceRef, ref.metricRef, first, first + 59 * 60_000)
      }
    })()
    const ids = Array.from({ length: 200 }, (_, i) => `hc-hr-${LINKS - 1 - i}`)
    const started = performance.now()
    const out = new CompanionRecords(ctx.db)
      .deleteRecords({ personId: 'p1', dataType: HEART_RATE, recordIds: ids, nowMs: 5 }, keys)
    const elapsed = performance.now() - started
    expect(out.rowsDeleted).toBe(200 * 60)
    expect(elapsed).toBeLessThan(3000)
    ctx.cleanup()
  }, 300_000)
})

describe('uncovered', () => {
  it('takes covered ranges out of a closed range, whatever their order and overlap', () => {
    expect(uncovered(0, 10, [])).toEqual([{ first: 0, last: 10 }])
    expect(uncovered(0, 10, [{ first: 3, last: 4 }])).toEqual([{ first: 0, last: 2 }, { first: 5, last: 10 }])
    expect(uncovered(0, 10, [{ first: 6, last: 20 }, { first: -5, last: 2 }, { first: 1, last: 3 }]))
      .toEqual([{ first: 4, last: 5 }])
    expect(uncovered(0, 10, [{ first: -1, last: 10 }])).toEqual([])
    expect(uncovered(0, 10, [{ first: 10, last: 10 }, { first: 0, last: 0 }])).toEqual([{ first: 1, last: 9 }])
  })
})
