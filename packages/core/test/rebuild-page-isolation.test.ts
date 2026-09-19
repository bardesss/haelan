import { afterEach, describe, expect, test } from 'vitest'
import { eq, inArray, sql } from 'drizzle-orm'
import { replayPerson } from '../src/rebuild/replay.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { SourceRegistry } from '../src/store/sources.ts'
import { rawPayloads, samples, sessions } from '../src/db/schema/index.ts'
import { body, samplePoint, sleepPoint } from '../src/testing/payloads.ts'
import { createTestDatabase, readSamples, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

let t: TestDatabase
afterEach(() => { t.cleanup() })
const freshDb = (): TestDatabase['db'] => { t = createTestDatabase(); return t.db }

const listParams = { filter: 'x', pageSize: 1000, pageToken: null }

// The two dropped-page reasons this file uses, spelled once. Both are what a real archive hands
// back for a body that will not inflate, established by running them through replayPerson before
// any of these tests were written: zlib's Z_DATA_ERROR for a blob that is not gzip at all, and
// Z_BUF_ERROR for one that was cut short. Neither carries a SQLITE_ code, so isFatalRebuildError
// leaves them droppable, which is the classification these tests depend on.
const NOT_GZIP_AT_ALL = 'incorrect header check'
const CUT_SHORT = 'unexpected end of file'

const replay = (db: TestDatabase['db'], archive: RawArchive): ReturnType<typeof replayPerson> =>
  db.transaction((tx) => replayPerson(tx, {
    personId: 'p1', payloads: archive.listFor('p1'), archive,
    sources: new SourceRegistry(db), nowMs: 1,
  }))

// A distinct night per call, so two pages of one window are two different sessions rather than
// one session archived twice - and so RawArchive.put does not deduplicate the second body away.
function nightBody(n: number): string {
  const day = String(10 + (n % 15)).padStart(2, '0')
  return body([sleepPoint({
    name: `users/me/dataTypes/sleep/dataPoints/n${n}`,
    startTime: `2026-08-${day}T21:30:00Z`,
    endTime: `2026-08-${day}T23:45:00Z`,
    stages: [{ type: 'LIGHT', startTime: `2026-08-${day}T21:30:00Z`, endTime: `2026-08-${day}T23:00:00Z` }],
  })])
}

const beatsBody = (beats: { atMs: number, bpm: number }[]): string =>
  body(beats.map((b) => samplePoint({
    payloadKey: 'heartRate', valuePath: 'beatsPerMinute', value: String(b.bpm),
    physicalTime: new Date(b.atMs).toISOString(),
    dataSource: { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' },
  })))

/**
 * Ruins the stored body of exactly these payloads, leaving every other row alone.
 *
 * The same hazard `corruptArchivedBodies` in fixtures.ts stands in for, narrowed to named rows
 * because these tests are about what happens to the pages beside a bad one. Ruined after
 * archiving rather than before, for the reason that fixture gives: `RawArchive.put` gzips
 * whatever it is handed, so no body survives storage and then fails to decompress.
 */
function ruin(db: TestDatabase['db'], ids: string[]): void {
  db.update(rawPayloads).set({ bodyGzip: Buffer.from('not gzip at all', 'utf8') })
    .where(inArray(rawPayloads.id, ids)).run()
}

/** The other half of a body that will not inflate: a valid gzip stream cut off part way. */
function truncate(db: TestDatabase['db'], id: string): void {
  const row = db.select({ bodyGzip: rawPayloads.bodyGzip }).from(rawPayloads)
    .where(eq(rawPayloads.id, id)).get()
  db.update(rawPayloads).set({ bodyGzip: row!.bodyGzip.subarray(0, 12) })
    .where(eq(rawPayloads.id, id)).run()
}

const externalIds = (db: TestDatabase['db']): string[] =>
  db.select({ externalId: sessions.externalId }).from(sessions)
    .where(eq(sessions.personId, 'p1')).all().map((r) => r.externalId).sort()

describe('replayPerson drops a unit rather than the person (#274)', () => {
  test('replays the pages either side of one it cannot get through', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // Three pages of one sleep window, so three units. The middle one's stored body is then
    // ruined: a page the replay cannot get through at all, which before this change threw out of
    // replayPerson, rolled the person's whole transaction back, and did it again on every boot.
    const ids = [1, 2, 3].map((n) => archive.put({
      personId: 'p1', dataType: 'sleep', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: n, httpStatus: 200,
      body: nightBody(n),
    }).id)
    ruin(db, [ids[1]!])

    const counts = replay(db, archive)

    // Both survivors by name, not a row count: a count of two would pass just as well if the
    // replay had written the first page twice, or had dropped the wrong page and kept the ruined
    // one's neighbours by luck.
    expect(externalIds(db)).toEqual([
      'users/me/dataTypes/sleep/dataPoints/n1',
      'users/me/dataTypes/sleep/dataPoints/n3',
    ])
    expect(counts.sessions).toBe(2)
    expect(counts.droppedPages).toBe(1)
    expect(counts.drops).toEqual([{ dataType: 'sleep', reason: NOT_GZIP_AT_ALL, pages: 1 }])
  })

  test('drops a samples episode whole, counting every page it covered', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // Two pages of one fetch, then a separate fetch of the same window. The boundary for samples
    // is the episode, not the page: mapWindowSamples takes a whole episode, and calling it per
    // page to isolate one would downsample across readings the original sync kept apart. So the
    // second page being unreadable costs the first page too, and the drop has to say 2 pages.
    const shared = {
      personId: 'p1', dataType: 'heart-rate', windowStartMs: 0, windowEndMs: 86_400_000,
      httpStatus: 200,
    } as const
    archive.put({
      ...shared, requestParams: listParams, fetchedAtMs: 1, fetchEpisodeId: 'ep-1',
      body: beatsBody([{ atMs: 60_000, bpm: 60 }]),
    })
    const secondPage = archive.put({
      ...shared, requestParams: { ...listParams, pageToken: 'p2' }, fetchedAtMs: 2,
      fetchEpisodeId: 'ep-1', body: beatsBody([{ atMs: 120_000, bpm: 70 }]),
    })
    archive.put({
      ...shared, requestParams: listParams, fetchedAtMs: 3, fetchEpisodeId: 'ep-2',
      body: beatsBody([{ atMs: 300_000, bpm: 80 }]),
    })
    ruin(db, [secondPage.id])

    const counts = replay(db, archive)

    // The surviving episode's minute and nothing else. Minute one came from the first page of
    // the ruined episode, and it must be absent: that page was readable, and keeping it would
    // mean the loop had fallen back to mapping pages one at a time.
    expect(readSamples(db, 'p1').map((r) => r.utcMs).sort((a, b) => a - b))
      .toEqual([300_000, 300_000, 300_000, 300_000])
    expect(counts.droppedPages).toBe(2)
    expect(counts.drops).toEqual([{ dataType: 'heart-rate', reason: NOT_GZIP_AT_ALL, pages: 2 }])
  })

  test('groups the drops by data type and reason, and counts pages within each', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // Five unreplayable pages across three faults: two sleep pages that are not gzip, one sleep
    // page cut short, and a two page heart-rate episode that is not gzip. Three rows, not five
    // and not one - the data type alone would merge the two sleep faults into a line whose count
    // describes neither, and no grouping at all would write a row per page.
    const notGzip = [1, 2].map((n) => archive.put({
      personId: 'p1', dataType: 'sleep', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: n, httpStatus: 200,
      body: nightBody(n),
    }).id)
    const cutShort = archive.put({
      personId: 'p1', dataType: 'sleep', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 3, httpStatus: 200,
      body: nightBody(3),
    }).id
    // One good sleep page, so the group is not wholly bad and the person keeps something.
    archive.put({
      personId: 'p1', dataType: 'sleep', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 4, httpStatus: 200,
      body: nightBody(4),
    })
    const beats = [5, 6].map((n) => archive.put({
      personId: 'p1', dataType: 'heart-rate',
      requestParams: n === 5 ? listParams : { ...listParams, pageToken: 'p2' },
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: n, httpStatus: 200,
      fetchEpisodeId: 'ep-1', body: beatsBody([{ atMs: n * 60_000, bpm: 60 + n }]),
    }).id)
    ruin(db, [...notGzip, ...beats])
    truncate(db, cutShort)

    const counts = replay(db, archive)

    expect(counts.droppedPages).toBe(5)
    // In the order each fault was first seen, which is the order listFor hands the pages back.
    expect(counts.drops).toEqual([
      { dataType: 'sleep', reason: NOT_GZIP_AT_ALL, pages: 2 },
      { dataType: 'sleep', reason: CUT_SHORT, pages: 1 },
      { dataType: 'heart-rate', reason: NOT_GZIP_AT_ALL, pages: 2 },
    ])
    expect(counts.sessions).toBe(1)
  })

  test('a clean archive drops nothing and reports an empty list', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    archive.put({
      personId: 'p1', dataType: 'sleep', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: 1, httpStatus: 200,
      body: nightBody(1),
    })

    const counts = replay(db, archive)

    expect(counts.droppedPages).toBe(0)
    expect(counts.drops).toEqual([])
    expect(counts.sessions).toBe(1)
  })
})

describe('replayPerson still abandons the person when the environment is at fault', () => {
  test('a full database aborts the rebuild instead of dropping page after page', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // A genuine SQLITE_FULL rather than a thrown stand-in: `max_page_count` is the knob SQLite
    // gives for exactly this, and a replay with more rows to write than the cap allows hits the
    // real error on a real write. Six windows of two hundred readings is several thousand sample
    // rows against two spare pages, so the cap is reached well inside the first window.
    for (let i = 0; i < 6; i += 1) {
      archive.put({
        personId: 'p1', dataType: 'heart-rate', requestParams: listParams,
        windowStartMs: i * 86_400_000, windowEndMs: (i + 1) * 86_400_000,
        fetchedAtMs: i + 1, httpStatus: 200,
        body: beatsBody(Array.from({ length: 200 }, (_, k) => ({
          atMs: i * 86_400_000 + k * 60_000, bpm: 60 + (k % 40),
        }))),
      })
    }
    const before = db.get<{ page_count: number }>(sql`pragma page_count`)
    db.run(sql.raw(`pragma max_page_count = ${before.page_count + 2}`))

    // The code, not the message: isFatalRebuildError reads `code` for the reason its own comment
    // gives, and a message is localised and reworded between SQLite releases.
    let thrown: { code?: string, message?: string } | undefined
    try {
      replay(db, archive)
    } catch (error) {
      thrown = error as { code?: string, message?: string }
    }
    expect(thrown?.code).toBe('SQLITE_FULL')

    // Nothing was committed, because the outer transaction rolled back with the throw. The
    // failure this pins is the other outcome: a full disk treated as bad data would drop every
    // page in turn and commit a near-empty rebuild that stamps the person current.
    db.run(sql.raw('pragma max_page_count = 1073741823'))
    expect(db.select({ n: sql<number>`count(*)` }).from(samples).get()?.n).toBe(0)
  })

  test('aborts once a hundred units have failed in a row', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    const ids = Array.from({ length: 150 }, (_, n) => archive.put({
      personId: 'p1', dataType: 'sleep', requestParams: listParams,
      windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: n + 1, httpStatus: 200,
      body: nightBody(n),
    }).id)
    ruin(db, ids)

    // The whole message, not a fragment of it: this is the only thing an operator sees when a
    // rebuild abandons a person, and a substring check stays green while the half that names the
    // cause rots away.
    expect(() => replay(db, archive)).toThrow(new Error(
      '100 consecutive pages could not be replayed for p1, which is an environment fault '
      + 'rather than bad data, so the rebuild is abandoned rather than committing a near-empty '
      + `archive: ${NOT_GZIP_AT_ALL}`,
    ))
  })

  test('does not trip the breaker when a success falls among the failures', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // 150 pages with every tenth one readable: 135 drops in runs of nine, which is what a real
    // archive carrying scattered bad pages looks like. A breaker counting total failures rather
    // than consecutive ones would abandon this person at the 100th, and would abandon a bigger
    // archive sooner the more history it held.
    const ruined: string[] = []
    for (let n = 0; n < 150; n += 1) {
      const page = archive.put({
        personId: 'p1', dataType: 'sleep', requestParams: listParams,
        windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: n + 1, httpStatus: 200,
        body: nightBody(n),
      })
      if (n % 10 !== 0) ruined.push(page.id)
    }
    ruin(db, ruined)

    const counts = replay(db, archive)

    expect(counts.droppedPages).toBe(135)
    expect(counts.drops).toEqual([{ dataType: 'sleep', reason: NOT_GZIP_AT_ALL, pages: 135 }])
    // nightBody cycles its date every fifteen nights, so the fifteen readable pages are fifteen
    // distinct sessions rather than one night archived over and over.
    expect(counts.sessions).toBe(15)
  })
})

// Not in the plan for this task, and added because isolating a page introduces this: the two
// identity caches replayPerson holds were both written assuming they never outlive a rollback of
// what they wrote, and a savepoint rollback is a rollback they now do outlive. See the comment on
// `afterUnit` in replay.ts.
describe('a dropped unit does not poison the units after it', () => {
  test('the next page gets a source row, not the id of the one that rolled back', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    // Two pages of one sleep window sharing a dataSource, so the first page is what creates the
    // person's only `sources` row and the second page resolves the same one. A trigger fails the
    // first page's session insert: a write that fails AFTER the unit created the source row,
    // which no unreadable body can be, since a body that will not inflate fails before the
    // mapper resolves anything.
    for (const n of [1, 2]) {
      archive.put({
        personId: 'p1', dataType: 'sleep', requestParams: listParams,
        windowStartMs: 0, windowEndMs: 86_400_000, fetchedAtMs: n, httpStatus: 200,
        body: nightBody(n),
      })
    }
    db.run(sql.raw(
      "create trigger refuse_n1 before insert on sessions "
      + "when new.external_id = 'users/me/dataTypes/sleep/dataPoints/n1' "
      + "begin select raise(abort, 'this row will not go in'); end",
    ))

    const counts = replay(db, archive)

    // The second page lands. Without clearing the caches it drops too, with `FOREIGN KEY
    // constraint failed`, because the source row it was handed the id of went back with the
    // savepoint - and on a real archive that repeats for every page after it until the breaker
    // fires, which costs the person the archive by a longer route than the one this milestone
    // removes.
    expect(externalIds(db)).toEqual(['users/me/dataTypes/sleep/dataPoints/n2'])
    expect(counts.droppedPages).toBe(1)
    expect(counts.drops).toEqual([
      { dataType: 'sleep', reason: 'this row will not go in', pages: 1 },
    ])
  })
})
