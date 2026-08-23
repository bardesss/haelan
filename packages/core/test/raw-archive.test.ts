import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { openDatabase, closeDatabase } from '../src/db/open.ts'
import { migrateToLatest } from '../src/db/migrate.ts'
import { people } from '../src/db/schema/index.ts'
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

  it('returns one person\'s payloads oldest window first', () => {
    const base = { personId: 'p1', requestParams: {}, fetchedAtMs: 1, httpStatus: 200 }
    archive.put({ ...base, dataType: 'steps', windowStartMs: 3000, windowEndMs: 4000, body: '{"c":1}' })
    archive.put({ ...base, dataType: 'steps', windowStartMs: 1000, windowEndMs: 2000, body: '{"a":1}' })
    archive.put({ ...base, dataType: 'steps', windowStartMs: 2000, windowEndMs: 3000, body: '{"b":1}' })

    const listed = archive.listFor('p1')

    expect(listed.map((p) => p.windowStartMs)).toEqual([1000, 2000, 3000])
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

  it('the request params come back so a replay can tell a rollup from a list', () => {
    archive.put({
      personId: 'p1', dataType: 'steps', requestParams: { range: { start: 'x', end: 'y' } },
      windowStartMs: 1000, windowEndMs: 2000, fetchedAtMs: 1, httpStatus: 200, body: '{}',
    })

    expect(JSON.parse(archive.listFor('p1')[0]!.requestParams)).toEqual({ range: { start: 'x', end: 'y' } })
  })
})
