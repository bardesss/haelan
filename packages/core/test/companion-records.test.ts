import { describe, it, expect } from 'vitest'
import { createTestDatabase, seedPerson, seedSession, readSamples } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { CompanionRecords } from '../src/store/companionRecords.ts'
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

function row(over: Partial<SampleRow>): SampleRow {
  return {
    personId: 'p1', sourceId: 'phone', metric: 'weight', utcMs: T0, tzOffsetMinutes: 120,
    agg: 'raw', value: 80, n: 1, rawPayloadId: 'x', ...over,
  }
}

// Stores rows and their links the way ingest will: through sampleRefs, then link.
function store(ctx: TestDatabase, rows: SampleRow[], withLinks = true): void {
  const { db } = ctx
  db.insert(sources).values({
    id: 'phone', personId: 'p1', externalId: 'phone', displayName: 'phone', kind: 'device', createdAtMs: 0,
  }).onConflictDoNothing().run()
  const keys = new SampleKeys(db)
  for (const r of rows) db.insert(samples).values(keys.sampleRefs({ ...r, rawPayloadId: null })).run()
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

  it('deleting a night removes the session by its external id', () => {
    const ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    seedSession(ctx.db, { id: 's1', personId: 'p1', kind: 'sleep', externalId: 'hc-night-1' })
    seedSession(ctx.db, { id: 's2', personId: 'p1', kind: 'sleep', externalId: 'hc-night-2' })
    const out = new CompanionRecords(ctx.db).deleteRecords(
      { personId: 'p1', dataType: SLEEP, recordIds: ['hc-night-1'], nowMs: 5 }, new SampleKeys(ctx.db))
    expect(out).toEqual({ rowsDeleted: 1, localDates: ['1970-01-01'] })
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
    expect(records.tombstoned('p1', ['hc-unknown', 'other'])).toEqual(new Set(['hc-unknown']))
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
})
