import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { people, sources, rawPayloads, metricDictionary } from '../src/db/schema/index.ts'

let test: TestDatabase

beforeEach(() => { test = createTestDatabase() })
afterEach(() => test.cleanup())

// person_id in raw_payloads has to point at a row that exists, so every raw_payloads insert here
// goes through a seeded person first, the same as every other table under test.
function insertRawPayload(id: string, personId: string): void {
  test.db.insert(rawPayloads).values({
    id,
    personId,
    dataType: 'heart-rate',
    requestParams: '{}',
    windowStartMs: 0,
    windowEndMs: 1,
    fetchedAtMs: 0,
    httpStatus: 200,
    bodyGzip: Buffer.from(''),
    bodyHash: id,
    bodyBytes: 0,
  }).run()
}

describe('surrogate refs are assigned on insert', () => {
  it('gives a person, a source and a raw payload each a positive integer ref', () => {
    seedPerson(test.db, 'p1')
    test.db.insert(sources).values(
      { id: 's1', personId: 'p1', externalId: 's1', displayName: 's1', kind: 'device', createdAtMs: 0 },
    ).run()
    insertRawPayload('r1', 'p1')

    const person = test.db.select().from(people).where(eq(people.id, 'p1')).get()
    const source = test.db.select().from(sources).where(eq(sources.id, 's1')).get()
    const payload = test.db.select().from(rawPayloads).where(eq(rawPayloads.id, 'r1')).get()

    expect(person?.ref).toBeGreaterThan(0)
    expect(Number.isInteger(person?.ref)).toBe(true)
    expect(source?.ref).toBeGreaterThan(0)
    expect(Number.isInteger(source?.ref)).toBe(true)
    expect(payload?.ref).toBeGreaterThan(0)
    expect(Number.isInteger(payload?.ref)).toBe(true)
  })

  it('never gives two rows in the same table the same ref', () => {
    seedPerson(test.db, 'p1')
    seedPerson(test.db, 'p2')
    test.db.insert(sources).values([
      { id: 's1', personId: 'p1', externalId: 's1', displayName: 's1', kind: 'device', createdAtMs: 0 },
      { id: 's2', personId: 'p1', externalId: 's2', displayName: 's2', kind: 'device', createdAtMs: 0 },
    ]).run()
    insertRawPayload('r1', 'p1')
    insertRawPayload('r2', 'p1')

    const peopleRefs = test.db.select({ ref: people.ref }).from(people).all()
    const sourceRefs = test.db.select({ ref: sources.ref }).from(sources).all()
    const payloadRefs = test.db.select({ ref: rawPayloads.ref }).from(rawPayloads).all()

    expect(peopleRefs).toHaveLength(2)
    expect(peopleRefs[0]?.ref).not.toBe(peopleRefs[1]?.ref)
    // sources and raw_payloads are the two tables production actually deletes rows from
    // (dropUnreferencedSources), so a reused ref here is the one that would silently repoint a
    // stored sample at the wrong entity.
    expect(sourceRefs).toHaveLength(2)
    expect(sourceRefs[0]?.ref).not.toBe(sourceRefs[1]?.ref)
    expect(payloadRefs).toHaveLength(2)
    expect(payloadRefs[0]?.ref).not.toBe(payloadRefs[1]?.ref)
  })

  // The trigger that assigns ref copies rowid; nothing else about it is guaranteed. Later tasks
  // store this ref in samples and expect it to keep meaning "this row", including across the
  // rowid lookups a backup or a migration might do directly. If a future change ever assigns ref
  // some other way, this is the test that has to fail, and it has to fail by naming the
  // invariant rather than as a UNIQUE constraint violation on an unrelated insert.
  //
  // Three rows inserted with no gaps would pass this identically under a plain running counter,
  // which is not what the comment above claims. So this deletes the middle row of three and
  // inserts a fourth, opening a gap between the counter a running total would produce and the
  // rowid SQLite actually assigns; only across that gap do the two diverge, which is what makes
  // asserting ref == rowid here mean the rowid relationship specifically.
  it('keeps ref equal to the row\'s own rowid, not merely a unique number assigned alongside it', () => {
    seedPerson(test.db, 'p1')
    seedPerson(test.db, 'p2')
    seedPerson(test.db, 'p3')
    test.db.delete(people).where(eq(people.id, 'p2')).run()
    seedPerson(test.db, 'p4')

    test.db.insert(sources).values(
      { id: 's1', personId: 'p1', externalId: 's1', displayName: 's1', kind: 'device', createdAtMs: 0 },
    ).run()
    test.db.insert(sources).values(
      { id: 's2', personId: 'p1', externalId: 's2', displayName: 's2', kind: 'device', createdAtMs: 0 },
    ).run()
    test.db.insert(sources).values(
      { id: 's3', personId: 'p1', externalId: 's3', displayName: 's3', kind: 'device', createdAtMs: 0 },
    ).run()
    test.db.delete(sources).where(eq(sources.id, 's2')).run()
    test.db.insert(sources).values(
      { id: 's4', personId: 'p1', externalId: 's4', displayName: 's4', kind: 'device', createdAtMs: 0 },
    ).run()

    insertRawPayload('r1', 'p1')
    insertRawPayload('r2', 'p1')
    insertRawPayload('r3', 'p1')
    test.db.delete(rawPayloads).where(eq(rawPayloads.id, 'r2')).run()
    insertRawPayload('r4', 'p1')

    for (const id of ['p1', 'p3', 'p4']) {
      const rowid = test.db.get<{ rowid: number }>(sql`select rowid from people where id = ${id}`)
      const person = test.db.select().from(people).where(eq(people.id, id)).get()
      expect(person?.ref, id).toBe(rowid?.rowid)
    }

    for (const id of ['s1', 's3', 's4']) {
      const rowid = test.db.get<{ rowid: number }>(sql`select rowid from sources where id = ${id}`)
      const source = test.db.select().from(sources).where(eq(sources.id, id)).get()
      expect(source?.ref, id).toBe(rowid?.rowid)
    }

    for (const id of ['r1', 'r3', 'r4']) {
      const rowid = test.db.get<{ rowid: number }>(sql`select rowid from raw_payloads where id = ${id}`)
      const payload = test.db.select().from(rawPayloads).where(eq(rawPayloads.id, id)).get()
      expect(payload?.ref, id).toBe(rowid?.rowid)
    }
  })
})

describe('metrics dictionary', () => {
  it('round-trips a name to a ref and back', () => {
    test.db.insert(metricDictionary).values({ name: 'heart_rate' }).run()
    const byName = test.db.select().from(metricDictionary).where(eq(metricDictionary.name, 'heart_rate')).get()
    expect(byName?.name).toBe('heart_rate')

    const byRef = test.db.select().from(metricDictionary).where(eq(metricDictionary.ref, byName!.ref)).get()
    expect(byRef?.name).toBe('heart_rate')
  })

  it('rejects a second row for the same name rather than producing two refs', () => {
    test.db.insert(metricDictionary).values({ name: 'steps' }).run()
    expect(() => test.db.insert(metricDictionary).values({ name: 'steps' }).run()).toThrow()

    const rows = test.db.select().from(metricDictionary).where(eq(metricDictionary.name, 'steps')).all()
    expect(rows).toHaveLength(1)
  })

  // The whole reason for AUTOINCREMENT: a plain INTEGER PRIMARY KEY reuses the highest rowid
  // once that row is gone, which would silently repoint every historical sample of a deleted
  // metric onto whatever gets inserted next. Asserting refs are merely unique passes identically
  // with or without the keyword; only "the next ref is higher than the one that was freed" tells
  // the two apart.
  it('does not reuse a ref after the row holding it is deleted', () => {
    test.db.insert(metricDictionary).values({ name: 'first' }).run()
    const second = test.db.insert(metricDictionary).values({ name: 'second' }).run()
    const secondRef = Number(second.lastInsertRowid)

    test.db.delete(metricDictionary).where(eq(metricDictionary.ref, secondRef)).run()

    const third = test.db.insert(metricDictionary).values({ name: 'third' }).run()
    const thirdRef = Number(third.lastInsertRowid)

    expect(thirdRef).toBeGreaterThan(secondRef)
  })
})
