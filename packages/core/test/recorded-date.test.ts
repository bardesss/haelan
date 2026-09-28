import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, insertSample } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { sessions, sources } from '../src/db/schema/index.ts'
import { PersonQuery } from '../src/query/personQuery.ts'

// 22:30 on the 20th in New York (UTC-4) is 02:30Z on the 21st: the date the row was recorded on
// is the 20th, whatever zone the reader is in now.
const AT = Date.parse('2026-09-21T02:30:00Z')

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({ id: 'phone', personId: 'p1', externalId: 'phone', displayName: 'Phone', kind: 'device', createdAtMs: 0 }).run()
})
afterEach(() => test.cleanup())

describe('PersonQuery.recordedDateOf', () => {
  it('dates a sample by the offset stored with it', () => {
    insertSample(test.db, { personId: 'p1', sourceId: 'phone', metric: 'weight', utcMs: AT, tzOffsetMinutes: -240, value: 80 })
    expect(new PersonQuery(test.db, 'p1').recordedDateOf({ utcMs: AT })).toBe('2026-09-20')
  })

  // A first upload of sleep alone: the history start is a session's start, and no sample sits at
  // that instant, so the session's own start offset is what dates it.
  it('dates a session start by its own start offset when no sample begins there', () => {
    test.db.insert(sessions).values({
      id: 'night', personId: 'p1', sourceId: 'phone', kind: 'sleep', externalId: 'night',
      startMs: AT, startOffsetMinutes: -240, endMs: AT + 8 * 3_600_000, endOffsetMinutes: -240,
      localDate: '2026-09-21', attrs: JSON.stringify({}), rawPayloadId: null,
    }).run()
    expect(new PersonQuery(test.db, 'p1').recordedDateOf({ utcMs: AT })).toBe('2026-09-20')
  })

  it('is null when no row of this person begins at the instant', () => {
    expect(new PersonQuery(test.db, 'p1').recordedDateOf({ utcMs: AT })).toBeNull()
  })
})
