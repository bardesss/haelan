import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { rebuildDrops, rebuildState } from '../src/db/schema/index.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

let fixture: TestDatabase

beforeEach(() => {
  fixture = createTestDatabase()
  seedPerson(fixture.db, 'p1')
})
afterEach(() => fixture.cleanup())

describe('rebuild tables', () => {
  it('defaults a fresh row to no failures and no drops', () => {
    fixture.db.insert(rebuildState).values({ personId: 'p1', lastAttemptAtMs: 10 }).run()
    const row = fixture.db.select().from(rebuildState).get()
    expect(row?.consecutiveFailures).toBe(0)
    expect(row?.droppedPages).toBe(0)
    expect(row?.lastError).toBeNull()
  })

  it('keys drops by person, type and reason, so one fault is one row', () => {
    fixture.db.insert(rebuildDrops)
      .values({ personId: 'p1', dataType: 'sleep', reason: 'UNIQUE', pages: 4 }).run()
    fixture.db.insert(rebuildDrops)
      .values({ personId: 'p1', dataType: 'sleep', reason: 'UNIQUE', pages: 9 })
      .onConflictDoUpdate({
        target: [rebuildDrops.personId, rebuildDrops.dataType, rebuildDrops.reason],
        set: { pages: 9 },
      }).run()
    const rows = fixture.db.select().from(rebuildDrops).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.pages).toBe(9)
  })
})
