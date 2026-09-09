import { afterEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RawArchive } from '../src/store/rawArchive.ts'
import { SourceRegistry } from '../src/store/sources.ts'
import { SampleKeys } from '../src/db/keys.ts'
import { replayPerson } from '../src/rebuild/replay.ts'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import { deriveDayInto } from '../src/derive/deriveDay.ts'
import { OverrideStore } from '../src/store/overrides.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import { DEFAULT_NIGHT_GAP_MINUTES } from '../src/derive/sleep.ts'
import { DEFAULT_OVERLAP_RATIO } from '../src/derive/sessionOverlap.ts'
import { sampleTarget } from '../src/derive/targetKey.ts'
import { daily, metricDictionary, people, samples, sources } from '../src/db/schema/index.ts'
import {
  createTestDatabase, insertSample, readSamples, seedPerson, seedRebuildable, REBUILDABLE_DATE,
} from '../src/testing/fixtures.ts'
import type { Rebuildable, TestDatabase } from '../src/testing/fixtures.ts'

/**
 * `samples` stopped repeating five text identifiers on every one of its rows and started carrying
 * an integer reference to each instead. Nothing about what the table means changed, which is the
 * hard part to hold: the columns a rebuild, a sync, a derivation, an override and a chart all key
 * on are now numbers whose meaning lives in another table, and every one of those paths had to
 * learn the translation at the same moment.
 *
 * So these are the claims that the representation changed and the content did not, plus the two
 * failures that would be silent if nobody pinned them: an upsert whose target no longer names the
 * columns the natural key is built on, and a `SampleKeys` reused past the transaction it was
 * built for.
 */

let t: TestDatabase | null = null
let h: Rebuildable | null = null
afterEach(() => {
  t?.cleanup(); t = null
  h?.cleanup(); h = null
})

const freshDb = (): TestDatabase['db'] => { t = createTestDatabase(); return t.db }

const tuning = {
  priority: priorityFrom({ lists: new Map(), sources: [] }),
  overrides: [],
  gapMinutes: DEFAULT_NIGHT_GAP_MINUTES,
  overlapRatio: DEFAULT_OVERLAP_RATIO,
  nowMs: 1,
}

describe('the stored representation', () => {
  it('holds an integer in every column that used to hold an identifier', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    db.insert(sources).values({
      id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch',
      kind: 'device', createdAtMs: 0,
    }).run()
    insertSample(db, {
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: 60_000, agg: 'mean', value: 62,
    })

    // sqlite's own opinion of what is in the cells, not drizzle's opinion of what the column was
    // declared as: the whole point of the change is the bytes on disk, and a text id written into
    // an integer column would still read back as a string here.
    const stored = db.get<Record<string, string>>(sql`
      select typeof(person_ref) as person, typeof(source_ref) as source,
             typeof(metric_ref) as metric, typeof(agg_ref) as agg
      from samples`)
    expect(stored).toEqual({ person: 'integer', source: 'integer', metric: 'integer', agg: 'integer' })
  })

  it('reads back the names it was written with', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    db.insert(sources).values({
      id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch',
      kind: 'device', createdAtMs: 0,
    }).run()
    insertSample(db, {
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: 60_000,
      tzOffsetMinutes: 120, agg: 'mean', value: 62, n: 3,
    })

    expect(readSamples(db)).toEqual([{
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: 60_000,
      tzOffsetMinutes: 120, agg: 'mean', value: 62, n: 3, rawPayloadId: null,
    }])
  })
})

describe('a rebuild through the new columns', () => {
  // The seeded archive is two heart-rate readings an hour apart, each downsampled to its own
  // minute, which is one row per aggregate: min, mean, max and count. Spelled out as a literal
  // rather than derived from the table, so this compares the rebuild's output against what the
  // archived payload says rather than against itself.
  const expectedHeartRate = [
    { agg: 'count', value: 1 }, { agg: 'max', value: 62 },
    { agg: 'mean', value: 62 }, { agg: 'min', value: 62 },
    { agg: 'count', value: 1 }, { agg: 'max', value: 71 },
    { agg: 'mean', value: 71 }, { agg: 'min', value: 71 },
  ]

  it('puts back the same content it always did, asserted on the names rather than the refs', () => {
    h = seedRebuildable()
    h.db.delete(samples).run()

    runRebuild({ ...h.deps, nowMs: 1 })

    const rows = readSamples(h.db, h.personId)
    // Every row names the source the registry resolved from the archived descriptor, and the
    // metric the catalogue maps heart rate to. A ref-shaped assertion could not tell either of
    // those from any other number.
    const sourceIds = h.db.select({ id: sources.id }).from(sources).all().map((row) => row.id)
    expect(new Set(rows.map((row) => row.sourceId))).toEqual(new Set(sourceIds))
    expect(new Set(rows.map((row) => row.metric))).toEqual(new Set(['heart_rate']))
    expect(rows.map((row) => ({ agg: row.agg, value: row.value }))
      .sort((a, b) => a.value! - b.value! || a.agg.localeCompare(b.agg)))
      .toEqual([...expectedHeartRate].sort((a, b) => a.value - b.value || a.agg.localeCompare(b.agg)))
  })

  it('produces a snapshot equal row for row when it runs a second time', () => {
    h = seedRebuildable()
    runRebuild({ ...h.deps, nowMs: 1 })
    const first = h.snapshot().samples

    // A different clock, so anything that leaked the moment of the rebuild into a sample row
    // would show up as a difference rather than compare equal by luck.
    runRebuild({ ...h.deps, nowMs: 999_999, force: true })

    expect(h.snapshot().samples).toEqual(first)
    expect(first.length).toBe(expectedHeartRate.length)
  })
})

describe('the natural key, rebuilt on refs', () => {
  it('upserts the same window rather than duplicating it or throwing', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    h = null

    // The trailing window a sync re-fetches on every run, replayed twice against the same
    // archive: the second pass maps the same minutes to the same five key columns and has to land
    // on the rows the first pass wrote. Before the change this was five text columns; if the
    // upsert target and the unique index disagree about which five they are now, the second pass
    // either doubles the table or aborts on the constraint.
    archive.put({
      personId: 'p1', dataType: 'heart-rate',
      requestParams: { filter: 'x', pageSize: 1000, pageToken: null },
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: JSON.stringify({
        dataPoints: [{
          dataSource: { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' },
          heartRate: {
            sampleTime: { physicalTime: new Date(60_000).toISOString(), utcOffset: '0s' },
            beatsPerMinute: '62',
          },
        }],
      }),
    })

    const replayOnce = (): number => db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }).samples)

    const afterFirst = replayOnce()
    expect(afterFirst).toBeGreaterThan(0)
    expect(replayOnce()).toBe(afterFirst)
    expect(readSamples(db, 'p1')).toHaveLength(afterFirst)
  })
})

describe('an override keyed on text, applied to rows keyed on refs', () => {
  const LOCAL_DATE = '2026-08-22'
  const NINE_AM = Date.UTC(2026, 7, 22, 9, 0)

  const seedTwoReadings = (db: TestDatabase['db']): void => {
    seedPerson(db, 'p1', { timezone: 'UTC' })
    db.insert(sources).values({
      id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch',
      kind: 'device', createdAtMs: 0,
    }).run()
    insertSample(db, {
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: NINE_AM, value: 210,
    })
    insertSample(db, {
      personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: NINE_AM + 60_000, value: 60,
    })
  }

  it('marks the day the named sample falls on, and excludes that reading from the day', () => {
    const db = freshDb()
    seedTwoReadings(db)

    const queue = new DeriveQueue(db)
    const store = new OverrideStore(db, queue)
    // The key is the source id and the metric name a person typed, unchanged by this task: the
    // translation has to happen where the key meets the rows. A target key that resolved to
    // nothing would not throw - it would mark no day and exclude no reading, and the spike the
    // person threw out would quietly come back.
    const targetKey = sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: NINE_AM })
    store.put({
      personId: 'p1', scope: 'sample', targetKey, action: 'exclude', reason: 'strap glitch',
      nowMs: 1,
    })

    expect(queue.claim(10)).toEqual([{ personId: 'p1', localDate: LOCAL_DATE }])

    db.transaction((tx) => deriveDayInto(tx, {
      ...tuning, personId: 'p1', localDate: LOCAL_DATE, overrides: store.listFor('p1'),
    }))

    const maxRow = db.select().from(daily).where(eq(daily.metric, 'heart_rate')).all()
      .find((row) => row.agg === 'max')
    // 60, not 210: the excluded reading is absent from the day's maximum rather than removed
    // from it afterwards.
    expect(maxRow?.value).toBe(60)
  })
})

describe('a SampleKeys that outlived its transaction', () => {
  /**
   * The hazard the class's own doc comment warns about, now enforced rather than described.
   *
   * A `SampleKeys` caches both directions in memory. Reuse one across a transaction boundary and
   * it keeps answering with refs for rows that rolled back - no query runs, so nothing notices.
   * Before `samples` declared its foreign keys, the resulting write landed: a row pointing at a
   * dictionary entry that does not exist, indistinguishable from a good row until something tried
   * to read its metric name back, which for a chart is months later and for a rebuild is never.
   *
   * Removing the `references(() => metricDictionary.ref)` from `metric_ref` is what this test
   * exists to catch; with it gone the insert below succeeds and leaves the dangling row.
   */
  it('fails the write loudly rather than storing a ref its transaction took away', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    db.insert(sources).values({
      id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch',
      kind: 'device', createdAtMs: 0,
    }).run()

    // Built outside any transaction and deliberately kept - this is the misuse.
    const keys = new SampleKeys(db)

    let staleMetricRef = 0
    expect(() => db.transaction(() => {
      // better-sqlite3 is one connection, so a statement issued through the outer handle inside
      // this callback is part of the transaction and rolls back with it. That is exactly why the
      // misuse is easy to make and impossible to see: nothing about `keys` looks transactional.
      staleMetricRef = keys.metricRef('ghost_metric')
      throw new Error('rolled back')
    })).toThrow('rolled back')

    expect(staleMetricRef).toBeGreaterThan(0)
    // The dictionary row went with the transaction, and the cache did not notice.
    expect(db.select().from(metricDictionary)
      .where(eq(metricDictionary.ref, staleMetricRef)).get()).toBeUndefined()
    expect(keys.metricRef('ghost_metric')).toBe(staleMetricRef)

    const personRef = db.select({ ref: people.ref }).from(people).where(eq(people.id, 'p1')).get()!.ref
    const sourceRef = db.select({ ref: sources.ref }).from(sources).where(eq(sources.id, 'watch')).get()!.ref

    expect(() => db.insert(samples).values({
      personRef, sourceRef, metricRef: staleMetricRef,
      utcMs: 60_000, tzOffsetMinutes: 0, aggRef: 1, value: 62, n: 1, rawPayloadRef: null,
    }).run()).toThrow(/FOREIGN KEY/i)

    // And nothing landed. Without the constraint the assertion above is the only thing that
    // fails and this one passes, which is why both are here.
    expect(readSamples(db, 'p1')).toEqual([])
  })
})

describe('the rebuildable fixture', () => {
  it('lands its rows on the date the rest of the suite reads them from', () => {
    // Guards the two rebuild claims above against a fixture change that moved the archived
    // window: they assert on content and count, neither of which would notice the day moving.
    h = seedRebuildable()
    runRebuild({ ...h.deps, nowMs: 1 })
    expect(h.db.select().from(daily).where(eq(daily.personId, h.personId)).all()
      .every((row) => row.localDate === REBUILDABLE_DATE)).toBe(true)
  })
})
