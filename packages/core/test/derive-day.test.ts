import { afterEach, describe, expect, test } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { deriveDayInto } from '../src/derive/deriveDay.ts'
import { daily } from '../src/db/schema/index.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import { DEFAULT_NIGHT_GAP_MINUTES } from '../src/derive/sleep.ts'
import { DEFAULT_OVERLAP_RATIO } from '../src/derive/sessionOverlap.ts'

import { createTestDatabase, seedDerivableDay } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

let t: TestDatabase
afterEach(() => { t.cleanup() })

// One person, one source, and samples on one local date. seedDerivableDay is added to
// src/testing/fixtures.ts by this task, beside the createTestDatabase and seedPerson helpers
// every other store test already imports from there.
const seedDay = (): { db: TestDatabase['db'], personId: string, localDate: string } => {
  t = createTestDatabase()
  return { db: t.db, ...seedDerivableDay(t.db) }
}

// DeriveDayInput wants a real Priority (a rank function), not the DEFAULT_LIST metric key.
// Nothing here configures a list, so every source falls back to the same unranked order.
const tuning = {
  priority: priorityFrom({ lists: new Map(), sources: [] }),
  overrides: [],
  gapMinutes: DEFAULT_NIGHT_GAP_MINUTES,
  overlapRatio: DEFAULT_OVERLAP_RATIO,
  nowMs: 1,
}

describe('deriveDayInto', () => {
  test('writes a day\'s derived rows through the handle it is given', () => {
    const { db, personId, localDate } = seedDay()

    const written = db.transaction((tx) =>
      deriveDayInto(tx, { personId, localDate, ...tuning }))

    expect(written).toBeGreaterThan(0)
    const rows = db.select().from(daily)
      .where(and(eq(daily.personId, personId), eq(daily.localDate, localDate))).all()
    expect(rows).toHaveLength(written)
  })

  test('a caller rolling back takes the derived rows with it', () => {
    const { db, personId, localDate } = seedDay()

    expect(() => db.transaction((tx) => {
      deriveDayInto(tx, { personId, localDate, ...tuning })
      throw new Error('caller changed its mind')
    })).toThrow('caller changed its mind')

    const rows = db.select().from(daily)
      .where(and(eq(daily.personId, personId), eq(daily.localDate, localDate))).all()
    expect(rows).toEqual([])
  })
})
