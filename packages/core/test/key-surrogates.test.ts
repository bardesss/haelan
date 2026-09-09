import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { people, sources, rawPayloads, metrics } from '../src/db/schema/index.ts'

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
    const rows = test.db.select({ ref: people.ref }).from(people).all()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.ref).not.toBe(rows[1]?.ref)
  })
})

describe('metrics dictionary', () => {
  it('round-trips a name to a ref and back', () => {
    test.db.insert(metrics).values({ name: 'heart_rate' }).run()
    const byName = test.db.select().from(metrics).where(eq(metrics.name, 'heart_rate')).get()
    expect(byName?.name).toBe('heart_rate')

    const byRef = test.db.select().from(metrics).where(eq(metrics.ref, byName!.ref)).get()
    expect(byRef?.name).toBe('heart_rate')
  })

  it('rejects a second row for the same name rather than producing two refs', () => {
    test.db.insert(metrics).values({ name: 'steps' }).run()
    expect(() => test.db.insert(metrics).values({ name: 'steps' }).run()).toThrow()

    const rows = test.db.select().from(metrics).where(eq(metrics.name, 'steps')).all()
    expect(rows).toHaveLength(1)
  })

  // The whole reason for AUTOINCREMENT: a plain INTEGER PRIMARY KEY reuses the highest rowid
  // once that row is gone, which would silently repoint every historical sample of a deleted
  // metric onto whatever gets inserted next. Asserting refs are merely unique passes identically
  // with or without the keyword; only "the next ref is higher than the one that was freed" tells
  // the two apart.
  it('does not reuse a ref after the row holding it is deleted', () => {
    test.db.insert(metrics).values({ name: 'first' }).run()
    const second = test.db.insert(metrics).values({ name: 'second' }).run()
    const secondRef = Number(second.lastInsertRowid)

    test.db.delete(metrics).where(eq(metrics.ref, secondRef)).run()

    const third = test.db.insert(metrics).values({ name: 'third' }).run()
    const thirdRef = Number(third.lastInsertRowid)

    expect(thirdRef).toBeGreaterThan(secondRef)
  })
})
