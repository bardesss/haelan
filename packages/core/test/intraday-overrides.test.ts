import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readIntraday } from '../src/query/intraday.ts'
import { OverrideStore } from '../src/store/overrides.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { overrides as overridesTable, samples, sources } from '../src/db/schema/index.ts'
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

describe('readIntraday applies a sample correction the way applyToSamples does', () => {
  // The finding this covers: readIntraday used to track only exclusions, so a correction written
  // from this chart changed the daily rollup (derivation applies it) but left the chart it was
  // corrected on drawing the original reading. Every aggregate the row feeds takes the corrected
  // value, the same as applyToSamples, so min, mean and max all move.
  it('changes min, mean and max to the corrected value', () => {
    insert({ utcMs: MINUTE_ONE, agg: 'min', value: 58 })
    insert({ utcMs: MINUTE_ONE, agg: 'mean', value: 62 })
    insert({ utcMs: MINUTE_ONE, agg: 'max', value: 71 })
    overrides.put({
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: MINUTE_ONE }),
      action: 'correct', correctedValue: 65, reason: 'strap glitch', nowMs: 1_000,
    })

    const result = read()
    expect(result.points).toEqual([
      { sourceId: 'watch', utcMs: MINUTE_ONE, min: 65, mean: 65, max: 65, n: 1, excluded: false },
    ])
  })

  // applyToSamples's own comment: a correction carrying no value is not an exclusion, and
  // assigning the null would leave the row present with nothing in it. The reading stands.
  it('leaves the reading standing when the correction carries a null value', () => {
    insert({ utcMs: MINUTE_ONE, agg: 'min', value: 58 })
    insert({ utcMs: MINUTE_ONE, agg: 'mean', value: 62 })
    insert({ utcMs: MINUTE_ONE, agg: 'max', value: 71 })
    // A null-valued correction can only be represented directly against the store's own row
    // shape: OverrideStore.validate refuses `correct` without a correctedValue from `put`, the
    // same guard the route sits behind, so this writes the row underneath the store the way a
    // stale or already-applied-elsewhere row could still be found sitting in the table.
    test.db.insert(overridesTable).values({
      id: 'null-correction', personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: MINUTE_ONE }),
      action: 'correct', correctedValue: null, reason: 'unspecified', createdAtMs: 1_000,
    }).run()

    const result = read()
    expect(result.points).toEqual([
      { sourceId: 'watch', utcMs: MINUTE_ONE, min: 58, mean: 62, max: 71, n: 1, excluded: false },
    ])
  })

  it('does not apply another person\'s correction', () => {
    insert({ utcMs: MINUTE_ONE, agg: 'mean', value: 60 })
    seedPerson(test.db, 'p2')
    new OverrideStore(test.db, new DeriveQueue(test.db)).put({
      personId: 'p2', scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: MINUTE_ONE }),
      action: 'correct', correctedValue: 99, reason: 'theirs', nowMs: 1_000,
    })

    const result = read()
    expect(result.points).toEqual([
      { sourceId: 'watch', utcMs: MINUTE_ONE, min: null, mean: 60, max: null, n: 1, excluded: false },
    ])
  })

  // Parsed and re-encoded rather than trusted as written (finding 5): a target key stored with a
  // different field order still passes OverrideStore.validate, which parses but does not
  // canonicalise before insert, and used to match nothing in this reader's own lookup while
  // applyToSamples, which does re-encode, applied it at derivation regardless. Written straight
  // against the table, the same reason the null-correction test above bypasses `put`: OverrideStore
  // itself always calls sampleTarget in the field order above and could never produce this key.
  it('applies a sample override whose stored key uses a different field order', () => {
    insert({ utcMs: MINUTE_ONE, agg: 'mean', value: 60 })
    test.db.insert(overridesTable).values({
      id: 'reordered-key', personId: 'p1', scope: 'sample',
      targetKey: JSON.stringify({ utcMs: MINUTE_ONE, metric: 'heart_rate', source: 'watch' }),
      action: 'exclude', correctedValue: null, reason: 'reordered on write', createdAtMs: 1_000,
    }).run()

    const result = read()
    expect(result.points).toEqual([
      { sourceId: 'watch', utcMs: MINUTE_ONE, min: null, mean: 60, max: null, n: 1, excluded: true },
    ])
  })
})

describe('the Correct guard\'s own instant, for a raw metric holding exactly one reading', () => {
  // Finding 4: for agg 'raw' rows a point's utcMs used to be the bucket start (the minute floored),
  // not a stored instant, so a raw minute holding exactly one reading offered Correct (n === 1) but
  // wrote sampleTarget({utcMs: <bucket start>}), which neither applyToSamples nor this reader's own
  // per-row lookup (keyed on row.utcMs) matches when the reading falls anywhere but the minute's
  // own top. The write succeeded and changed nothing. Fifteen seconds into the minute, not on its
  // boundary, is what tells the bucket start and the row's real instant apart.
  //
  // Taken from the point the reader itself returned, not from the inserted instant directly: that
  // is the only route AnnotatePanel actually has (IntradayHeartRate.tsx's onClick hands the panel
  // the clicked point's own utcMs), so a test that built the override straight from `readingMs`
  // would pass even if readIntraday still reported the bucket start, the exact defect this covers.
  it('changes the value a correction written against the reader\'s own point actually changes', () => {
    const readingMs = MINUTE_ONE + 15_000
    insert({ utcMs: readingMs, agg: 'raw', value: 97, metric: 'spo2' })

    const before = read('spo2')
    expect(before.points).toHaveLength(1)
    expect(before.points[0]!.n).toBe(1)
    // The assertion that would have caught this directly: n === 1 promises a stored instant, and
    // the bucket start this point used to carry is not one (nothing was inserted at MINUTE_ONE).
    expect(before.points[0]!.utcMs).toBe(readingMs)

    overrides.put({
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'spo2', utcMs: before.points[0]!.utcMs }),
      action: 'correct', correctedValue: 94, reason: 'recalibrated', nowMs: 1_000,
    })

    const after = read('spo2')
    expect(after.points).toEqual([
      { sourceId: 'watch', utcMs: readingMs, min: 94, mean: 94, max: 94, n: 1, excluded: false },
    ])
  })

  // The other side of the guard: two readings in the same minute leave no single instant to name,
  // so the bucket start is what the point keeps, and a correction has no real row to land on either
  // way — which is exactly why AnnotatePanel withholds Correct whenever n is not 1.
  it('leaves a multi-reading bucket at its own start, where Correct is withheld', () => {
    insert({ utcMs: MINUTE_ONE + 5_000, agg: 'raw', value: 97, metric: 'spo2' })
    insert({ utcMs: MINUTE_ONE + 40_000, agg: 'raw', value: 95, metric: 'spo2' })

    const result = read('spo2')
    expect(result.points).toEqual([
      { sourceId: 'watch', utcMs: MINUTE_ONE, min: 95, mean: 96, max: 97, n: 2, excluded: false },
    ])
  })
})
