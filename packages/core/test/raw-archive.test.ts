import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { openDatabase, closeDatabase } from '../src/db/open.ts'
import { migrateToLatest } from '../src/db/migrate.ts'
import { people, rawPayloads } from '../src/db/schema/index.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import type { Database } from '../src/db/open.ts'

const body = JSON.stringify({ dataPoints: [{ steps: { count: 1 } }] })
const base = {
  personId: 'p1', dataType: 'steps', requestParams: { filter: 'x' },
  windowStartMs: 1000, windowEndMs: 2000, httpStatus: 200,
}

describe('RawArchive', () => {
  let dir: string
  let db: Database
  let archive: RawArchive

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'haelan-'))
    db = openDatabase(dir)
    migrateToLatest(db)
    db.insert(people).values({
      id: 'p1', displayName: 'Test', timezone: 'Europe/Amsterdam', createdAtMs: 0,
    }).run()
    archive = new RawArchive(db)
  })
  afterEach(() => { closeDatabase(db); rmSync(dir, { recursive: true, force: true }) })

  it('stores a payload and reads the body back unchanged', () => {
    const { id } = archive.put({ ...base, body, fetchedAtMs: 10 })
    expect(archive.getBody('p1', id)).toBe(body)
  })

  it('refuses to return a body to a person who does not own it', () => {
    db.insert(people).values({
      id: 'p2', displayName: 'Other', timezone: 'Europe/Amsterdam', createdAtMs: 0,
    }).run()
    const { id } = archive.put({ ...base, body, fetchedAtMs: 10 })
    expect(archive.getBody('p1', id)).toBe(body)
    expect(() => archive.getBody('p2', id)).toThrow(/not found/)
  })

  it('compresses the body, because heart rate alone is 23 MB per person-day', () => {
    const repetitive = JSON.stringify({ dataPoints: Array.from({ length: 500 }, () => ({ heartRate: { beatsPerMinute: '60' } })) })
    const { id } = archive.put({ ...base, body: repetitive, fetchedAtMs: 10 })
    const rows = db.all<{ stored: number, original: number }>(
      sql`select length(body_gzip) as stored, body_bytes as original from raw_payloads where id = ${id}`,
    )
    expect(rows[0]!.stored).toBeLessThan(rows[0]!.original / 4)
  })

  it('deduplicates an identical body, because every run re-fetches a trailing window', () => {
    const first = archive.put({ ...base, body, fetchedAtMs: 10 })
    const second = archive.put({ ...base, body, fetchedAtMs: 99 })
    expect(second.deduplicated).toBe(true)
    expect(second.id).toBe(first.id)
    expect(db.all(sql`select 1 from raw_payloads`)).toHaveLength(1)
  })

  it('keeps identical bodies from two different windows as separate rows, so an empty day stays distinguishable from an unfetched one', () => {
    const first = archive.put({ ...base, windowStartMs: 1000, windowEndMs: 2000, body, fetchedAtMs: 10 })
    const second = archive.put({ ...base, windowStartMs: 87400000, windowEndMs: 87500000, body, fetchedAtMs: 10 })
    expect(second.deduplicated).toBe(false)
    expect(second.id).not.toBe(first.id)
    expect(db.all(sql`select 1 from raw_payloads`)).toHaveLength(2)
  })

  it('still dedups an identical body archived twice for the same window', () => {
    const first = archive.put({ ...base, windowStartMs: 1000, windowEndMs: 2000, body, fetchedAtMs: 10 })
    const second = archive.put({ ...base, windowStartMs: 1000, windowEndMs: 2000, body, fetchedAtMs: 99 })
    expect(second.deduplicated).toBe(true)
    expect(second.id).toBe(first.id)
    expect(db.all(sql`select 1 from raw_payloads`)).toHaveLength(1)
  })

  it('keeps two windows that share a start but differ in end as separate rows, so the wider fetch is not discarded', () => {
    const first = archive.put({ ...base, windowStartMs: 1000, windowEndMs: 2000, body, fetchedAtMs: 10 })
    const second = archive.put({ ...base, windowStartMs: 1000, windowEndMs: 3000, body, fetchedAtMs: 10 })
    expect(second.deduplicated).toBe(false)
    expect(second.id).not.toBe(first.id)
    expect(db.all(sql`select 1 from raw_payloads`)).toHaveLength(2)
  })

  it('still dedups an identical body archived twice for the same window, end included', () => {
    const first = archive.put({ ...base, windowStartMs: 1000, windowEndMs: 3000, body, fetchedAtMs: 10 })
    const second = archive.put({ ...base, windowStartMs: 1000, windowEndMs: 3000, body, fetchedAtMs: 99 })
    expect(second.deduplicated).toBe(true)
    expect(second.id).toBe(first.id)
    expect(db.all(sql`select 1 from raw_payloads`)).toHaveLength(1)
  })

  it('resolves a conflicting insert to dedup instead of throwing', () => {
    const first = archive.put({ ...base, body, fetchedAtMs: 10 })
    const second = archive.put({ ...base, body, fetchedAtMs: 10 })
    expect(second.id).toBe(first.id)
    expect(second.deduplicated).toBe(true)
  })

  it('keeps a changed body as a new row, because the archive is append only', () => {
    archive.put({ ...base, body, fetchedAtMs: 10 })
    const changed = archive.put({ ...base, body: JSON.stringify({ dataPoints: [] }), fetchedAtMs: 11 })
    expect(changed.deduplicated).toBe(false)
    expect(db.all(sql`select 1 from raw_payloads`)).toHaveLength(2)
  })

  it('separates identical bodies belonging to different people', () => {
    db.insert(people).values({
      id: 'p2', displayName: 'Other', timezone: 'Europe/Amsterdam', createdAtMs: 0,
    }).run()
    archive.put({ ...base, body, fetchedAtMs: 10 })
    const other = archive.put({ ...base, personId: 'p2', body, fetchedAtMs: 10 })
    expect(other.deduplicated).toBe(false)
    expect(db.all(sql`select 1 from raw_payloads`)).toHaveLength(2)
  })

  it('archives a failed response too, because schema drift must not lose the payload', () => {
    const { id } = archive.put({ ...base, body: '{"error":{"code":400}}', httpStatus: 400, fetchedAtMs: 10 })
    expect(archive.getBody('p1', id)).toContain('400')
  })

  it('stores the fetch episode the caller names', () => {
    archive.put({ ...base, body, fetchedAtMs: 10, fetchEpisodeId: 'ep-1' })
    const rows = db.all<{ fetch_episode_id: string | null }>(
      sql`select fetch_episode_id from raw_payloads`,
    )
    expect(rows[0]!.fetch_episode_id).toBe('ep-1')
  })

  it('leaves the fetch episode null when no caller names one, which is what every row archived before the column existed looks like', () => {
    archive.put({ ...base, body, fetchedAtMs: 10 })
    const rows = db.all<{ fetch_episode_id: string | null }>(
      sql`select fetch_episode_id from raw_payloads`,
    )
    expect(rows[0]!.fetch_episode_id).toBe(null)
  })

  it('does not let a new episode id defeat body dedup', () => {
    // Every fetch episode has an id of its own, so folding it into the dedup key would end
    // deduplication outright: the trailing window is re-fetched on every run and its unchanged
    // pages would be archived again on each one, which is exactly the storage growth the body
    // hash key exists to prevent. The first episode to archive a body keeps the row, and the
    // replay reads that body as part of the episode that first saw it.
    const first = archive.put({ ...base, body, fetchedAtMs: 10, fetchEpisodeId: 'ep-1' })
    const second = archive.put({ ...base, body, fetchedAtMs: 99, fetchEpisodeId: 'ep-2' })
    expect(second.deduplicated).toBe(true)
    expect(second.id).toBe(first.id)
    expect(db.all(sql`select 1 from raw_payloads`)).toHaveLength(1)
    const rows = db.all<{ fetch_episode_id: string | null }>(
      sql`select fetch_episode_id from raw_payloads`,
    )
    expect(rows[0]!.fetch_episode_id).toBe('ep-1')
  })
})

describe('listFor', () => {
  let dir: string
  let db: Database
  let archive: RawArchive

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'haelan-'))
    db = openDatabase(dir)
    migrateToLatest(db)
    db.insert(people).values({
      id: 'p1', displayName: 'Test', timezone: 'Europe/Amsterdam', createdAtMs: 0,
    }).run()
    archive = new RawArchive(db)
  })
  afterEach(() => { closeDatabase(db); rmSync(dir, { recursive: true, force: true }) })

  it('returns one person\'s payloads oldest fetch first, whatever their window bounds sort like', () => {
    // Window bounds run in the reverse of fetch order on purpose, so the two orderings disagree
    // and this can say which one won: window order would return [1000, 2000, 3000] and only
    // fetch order returns [3000, 2000, 1000]. Sharing one fetchedAtMs across all three rows
    // cannot tell them apart, because the fetch time then ties and the window decides regardless
    // of which column the implementation checks first.
    //
    // Fetch time is the one that matters. A replay has to land a later body after the one it
    // corrects, and window bounds agree with fetch order only while the person's timezone holds
    // still. See the note on listFor.
    const base = { personId: 'p1', dataType: 'steps', requestParams: {}, httpStatus: 200 }
    archive.put({ ...base, windowStartMs: 3000, windowEndMs: 4000, fetchedAtMs: 1, body: '{"c":1}' })
    archive.put({ ...base, windowStartMs: 1000, windowEndMs: 2000, fetchedAtMs: 3, body: '{"a":1}' })
    archive.put({ ...base, windowStartMs: 2000, windowEndMs: 3000, fetchedAtMs: 2, body: '{"b":1}' })

    const listed = archive.listFor('p1')

    expect(listed.map((p) => p.fetchedAtMs)).toEqual([1, 2, 3])
    expect(listed.map((p) => p.windowStartMs)).toEqual([3000, 2000, 1000])
  })

  it('two fetches of one window come back in fetch order', () => {
    const base = { personId: 'p1', dataType: 'steps', requestParams: {}, windowStartMs: 1000, windowEndMs: 2000, httpStatus: 200 }
    archive.put({ ...base, fetchedAtMs: 200, body: '{"corrected":true}' })
    archive.put({ ...base, fetchedAtMs: 100, body: '{"corrected":false}' })

    const listed = archive.listFor('p1')

    expect(listed.map((p) => p.fetchedAtMs)).toEqual([100, 200])
  })

  it('a non-200 response is not listed', () => {
    const base = { personId: 'p1', dataType: 'steps', requestParams: {}, windowStartMs: 1000, windowEndMs: 2000, fetchedAtMs: 1 }
    archive.put({ ...base, httpStatus: 429, body: '{"error":"slow down"}' })

    expect(archive.listFor('p1')).toEqual([])
  })

  it('another person\'s payloads are not listed', () => {
    db.insert(people).values({
      id: 'p2', displayName: 'Other', timezone: 'Europe/Amsterdam', createdAtMs: 0,
    }).run()
    const base = { dataType: 'steps', requestParams: {}, windowStartMs: 1000, windowEndMs: 2000, fetchedAtMs: 1, httpStatus: 200 }
    archive.put({ ...base, personId: 'p1', body: '{"mine":1}' })
    archive.put({ ...base, personId: 'p2', body: '{"theirs":1}' })

    expect(archive.listFor('p1')).toHaveLength(1)
  })

  it('returns the fetch episode id, which is what a replay groups the pages of one call by', () => {
    archive.put({
      personId: 'p1', dataType: 'steps', requestParams: {},
      windowStartMs: 1000, windowEndMs: 2000, fetchedAtMs: 1, httpStatus: 200,
      body: '{"a":1}', fetchEpisodeId: 'ep-1',
    })
    // A second row with no episode id at all, the shape of everything archived before the
    // column existed. listFor has to hand both back, so the replay can tell which grouping
    // rule each row needs rather than assuming the archive is all one kind.
    archive.put({
      personId: 'p1', dataType: 'steps', requestParams: {},
      windowStartMs: 2000, windowEndMs: 3000, fetchedAtMs: 2, httpStatus: 200, body: '{"b":1}',
    })

    expect(archive.listFor('p1').map((p) => p.fetchEpisodeId)).toEqual(['ep-1', null])
  })

  it('the request params come back so a replay can tell a rollup from a list', () => {
    archive.put({
      personId: 'p1', dataType: 'steps', requestParams: { range: { start: 'x', end: 'y' } },
      windowStartMs: 1000, windowEndMs: 2000, fetchedAtMs: 1, httpStatus: 200, body: '{}',
    })

    expect(JSON.parse(archive.listFor('p1')[0]!.requestParams)).toEqual({ range: { start: 'x', end: 'y' } })
  })

  it('breaks a tie on data type, both window bounds and fetch time by id, so a rebuild is deterministic', () => {
    // put() always assigns a random id, so proving the id tiebreak needs two rows that tie on
    // every other ordering column with ids chosen by the test, not generated. Asserting the
    // returned ids equal a sorted copy of themselves would be tautological, and letting put()
    // pick random ids would make the test pass or fail depending on whether insertion order
    // happened to already match sorted order, roughly half the time either way. Inserting
    // 'zzz...' before 'aaa...' means the only way this test passes is if listFor sorts by id;
    // returning rows in insertion order, which is what dropping the trailing asc(id) falls back
    // to, would return 'zzz...' first and fail.
    const tied = {
      personId: 'p1', dataType: 'steps', requestParams: '{}',
      windowStartMs: 1000, windowEndMs: 2000, fetchedAtMs: 1, httpStatus: 200,
      bodyBytes: 1,
    }
    db.insert(rawPayloads).values({
      ...tied, id: 'zzzzzzzz-0000-0000-0000-000000000000', bodyHash: 'hash-z', bodyGzip: Buffer.from('z'),
    }).run()
    db.insert(rawPayloads).values({
      ...tied, id: 'aaaaaaaa-0000-0000-0000-000000000000', bodyHash: 'hash-a', bodyGzip: Buffer.from('a'),
    }).run()

    const listed = archive.listFor('p1')

    expect(listed.map((p) => p.id)).toEqual([
      'aaaaaaaa-0000-0000-0000-000000000000', 'zzzzzzzz-0000-0000-0000-000000000000',
    ])
  })
})
