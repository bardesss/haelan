import { afterEach, describe, expect, test } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { deriveDayInto } from '../src/derive/deriveDay.ts'
import { daily } from '../src/db/schema/index.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import { DEFAULT_NIGHT_GAP_MINUTES } from '../src/derive/sleep.ts'
import { DEFAULT_OVERLAP_RATIO } from '../src/derive/sessionOverlap.ts'
import { downsampleToMinute } from '../src/api/downsample.ts'
import type { SampleRow } from '../src/api/mapSamples.ts'

import { createTestDatabase, insertSample, seedDerivableDay } from '../src/testing/fixtures.ts'
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

  // The composition this pins: mapWindowSamples' downsampler is what emits the count row, and
  // rollUpDay's count aggregate is what a day rolls it up into. Neither layer's own tests cross
  // into the other, so nothing before this failed if the two stopped fitting together, whether
  // the daily count aggregate stopped reading the downsampled agg or the downsampler stopped
  // emitting it.
  test('a day of downsampled heart rate samples rolls up to a daily count row', () => {
    const { db, personId, localDate } = seedDay()

    const readingAt = (utcMs: number, bpm: number): SampleRow => ({
      personId, sourceId: 'watch', metric: 'heart_rate',
      utcMs, tzOffsetMinutes: 0, agg: 'raw', value: bpm, n: 1, rawPayloadId: 'r1',
    })
    const minuteStart = Date.parse(`${localDate}T10:00:00Z`)
    const readings = [
      readingAt(minuteStart, 60), readingAt(minuteStart + 2_000, 61), readingAt(minuteStart + 4_000, 62),
      readingAt(minuteStart + 60_000, 70), readingAt(minuteStart + 62_000, 71),
    ]
    const downsampled = downsampleToMinute(readings)

    // rawPayloadId is nulled rather than kept: nothing in this test archives a payload for it to
    // reference, and the foreign key exists precisely to catch a row claiming one that is not there.
    for (const row of downsampled) insertSample(db, { ...row, rawPayloadId: null })

    db.transaction((tx) => deriveDayInto(tx, { personId, localDate, ...tuning }))

    const countRow = db.select().from(daily).where(and(
      eq(daily.personId, personId), eq(daily.localDate, localDate),
      eq(daily.metric, 'heart_rate'), eq(daily.agg, 'count'),
    )).get()
    expect(countRow?.value).toBe(readings.length)
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
