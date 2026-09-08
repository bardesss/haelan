import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { sources } from '../src/db/schema/index.ts'
import { ObservationStore } from '../src/store/observations.ts'
import type { ObservationRow } from '../src/store/observations.ts'

let test: TestDatabase
let store: ObservationStore
const NOW = 1_770_000_000_000

function row(overrides: Partial<ObservationRow> & { id: string, personId: string }): ObservationRow {
  return {
    sourceId: 'watch',
    kind: 'mood',
    startedAtMs: NOW,
    startedAtOffsetMinutes: 0,
    endedAtMs: null,
    endedAtOffsetMinutes: null,
    localDate: '2026-08-22',
    value: 'happy',
    rawPayloadId: null,
    ...overrides,
  }
}

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  seedPerson(test.db, 'p2')
  test.db.insert(sources).values(
    { id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0 },
  ).run()
  test.db.insert(sources).values(
    { id: 'watch2', personId: 'p2', externalId: 'watch2', displayName: 'watch2', kind: 'device', createdAtMs: 0 },
  ).run()
  store = new ObservationStore(test.db)
})
afterEach(() => test.cleanup())

describe('writeMany / listFor', () => {
  it('returns what was written, whole rows', () => {
    const input = row({ id: 'o1', personId: 'p1' })
    store.writeMany([input])
    expect(store.listFor('p1', '2026-08-22', '2026-08-22')).toEqual([input])
  })

  it('is bounded by local_date inclusively at both ends', () => {
    store.writeMany([
      row({ id: 'before', personId: 'p1', localDate: '2026-08-21' }),
      row({ id: 'start', personId: 'p1', localDate: '2026-08-22' }),
      row({ id: 'end', personId: 'p1', localDate: '2026-08-24' }),
      row({ id: 'after', personId: 'p1', localDate: '2026-08-25' }),
    ])
    const ids = store.listFor('p1', '2026-08-22', '2026-08-24').map((r) => r.id)
    expect(ids).toEqual(['start', 'end'])
  })

  it('does not return another person\'s rows', () => {
    store.writeMany([
      row({ id: 'mine', personId: 'p1' }),
      row({ id: 'theirs', personId: 'p2', sourceId: 'watch2' }),
    ])
    expect(store.listFor('p1', '2026-08-22', '2026-08-22').map((r) => r.id)).toEqual(['mine'])
    expect(store.listFor('p2', '2026-08-22', '2026-08-22').map((r) => r.id)).toEqual(['theirs'])
  })

  // The reason this table exists rather than reusing events: a point observation has no end,
  // and sqlite blurring that into 0 would read back as an interval of length zero.
  it('round-trips a point observation\'s endedAtMs as null, not zero', () => {
    const input = row({
      id: 'point', personId: 'p1', endedAtMs: null, endedAtOffsetMinutes: null,
    })
    store.writeMany([input])
    const [result] = store.listFor('p1', '2026-08-22', '2026-08-22')
    expect(result?.endedAtMs).toBeNull()
    expect(result?.endedAtOffsetMinutes).toBeNull()
  })
})

describe('deleteForPerson', () => {
  it('removes one person\'s rows and leaves another\'s', () => {
    store.writeMany([
      row({ id: 'mine', personId: 'p1' }),
      row({ id: 'theirs', personId: 'p2', sourceId: 'watch2' }),
    ])
    const deleted = store.deleteForPerson('p1')
    expect(deleted).toBe(1)
    expect(store.listFor('p1', '2026-08-22', '2026-08-22')).toEqual([])
    expect(store.listFor('p2', '2026-08-22', '2026-08-22').map((r) => r.id)).toEqual(['theirs'])
  })
})
