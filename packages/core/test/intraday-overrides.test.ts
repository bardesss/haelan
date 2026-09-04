import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readIntraday } from '../src/query/intraday.ts'
import { OverrideStore } from '../src/store/overrides.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { samples, sources } from '../src/db/schema/index.ts'
import type { SampleAgg } from '../src/db/schema/index.ts'
import { sampleTarget } from '../src/derive/targetKey.ts'

const OFFSET = 120
const LOCAL_DATE = '2026-08-22'

// 09:00 local on 2026-08-22 at +120 is 07:00Z, the same anchor intraday.test.ts uses.
const MINUTE_ONE = Date.UTC(2026, 7, 22, 7, 0)
const MINUTE_TWO = Date.UTC(2026, 7, 22, 7, 1)

let test: TestDatabase
let overrides: OverrideStore

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  for (const id of ['watch', 'phone']) {
    test.db.insert(sources).values({
      id, personId: 'p1', externalId: id, displayName: id, kind: 'device', createdAtMs: 0,
    }).run()
  }
  overrides = new OverrideStore(test.db, new DeriveQueue(test.db))
})
afterEach(() => test.cleanup())

const insert = (o: {
  utcMs: number, agg: SampleAgg, value: number, tzOffsetMinutes?: number, sourceId?: string, metric?: string,
}) =>
  test.db.insert(samples).values({
    personId: 'p1', sourceId: o.sourceId ?? 'watch', metric: o.metric ?? 'heart_rate', utcMs: o.utcMs,
    tzOffsetMinutes: o.tzOffsetMinutes ?? OFFSET, agg: o.agg, value: o.value, n: 1,
    rawPayloadId: null,
  }).run()

const read = (metric = 'heart_rate') =>
  readIntraday(test.db, { personId: 'p1', metric, localDate: LOCAL_DATE })

describe('readIntraday, n and exclusions', () => {
  // Heart rate is stored downsampled to the minute, so one point is one stored row and Correct
  // is offerable. This is the number task 5's guard reads.
  it('reports n as 1 for a minute holding one stored row', () => {
    insert({ utcMs: MINUTE_ONE, agg: 'mean', value: 60 })
    insert({ utcMs: MINUTE_ONE + 60_000, agg: 'mean', value: 61 })
    insert({ utcMs: MINUTE_ONE + 120_000, agg: 'mean', value: 62 })

    const result = read()
    expect(result.points.map((p) => p.n)).toEqual([1, 1, 1])
  })

  // spo2 is stored one row per reading, so a minute can hold several and no single instant
  // identifies the point.
  it('reports n as the number of readings combined into the minute', () => {
    insert({ utcMs: MINUTE_ONE, agg: 'raw', value: 97, metric: 'spo2' })
    insert({ utcMs: MINUTE_ONE + 10_000, agg: 'raw', value: 95, metric: 'spo2' })
    insert({ utcMs: MINUTE_ONE + 20_000, agg: 'raw', value: 96, metric: 'spo2' })

    const result = read('spo2')
    expect(result.points.map((p) => p.n)).toEqual([3])
  })

  it('marks a point whose sample this person excluded', () => {
    insert({ utcMs: MINUTE_ONE, agg: 'mean', value: 60 })
    insert({ utcMs: MINUTE_TWO, agg: 'mean', value: 61 })
    overrides.put({
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: MINUTE_ONE }),
      action: 'exclude', reason: 'strap slipped', nowMs: 1_000,
    })

    const result = read()
    expect(result.points.map((p) => ({ utcMs: p.utcMs, excluded: p.excluded })))
      .toEqual([
        { utcMs: MINUTE_ONE, excluded: true },
        { utcMs: MINUTE_TWO, excluded: false },
      ])
  })

  it('does not apply another person\'s override', () => {
    insert({ utcMs: MINUTE_ONE, agg: 'mean', value: 60 })
    insert({ utcMs: MINUTE_TWO, agg: 'mean', value: 61 })
    seedPerson(test.db, 'p2')
    new OverrideStore(test.db, new DeriveQueue(test.db)).put({
      personId: 'p2', scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: MINUTE_ONE }),
      action: 'exclude', reason: 'theirs', nowMs: 1_000,
    })

    const result = read()
    expect(result.points.every((p) => !p.excluded)).toBe(true)
  })

  // A sample override names one source; another device's reading in the same minute is untouched.
  it('marks only the excluded source\'s point', () => {
    insert({ utcMs: MINUTE_ONE, agg: 'mean', value: 60, sourceId: 'watch' })
    insert({ utcMs: MINUTE_ONE, agg: 'mean', value: 90, sourceId: 'phone' })
    overrides.put({
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: MINUTE_ONE }),
      action: 'exclude', reason: 'strap slipped', nowMs: 1_000,
    })

    const result = read()
    // Direct order, not sorted before comparing: 'phone' sorts before 'watch' at the same utcMs,
    // the same tie-break intraday.test.ts documents for two sources at one minute.
    expect(result.points.map((p) => ({ sourceId: p.sourceId, excluded: p.excluded })))
      .toEqual([
        { sourceId: 'phone', excluded: false },
        { sourceId: 'watch', excluded: true },
      ])
  })
})
