import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PersonQuery, PROJECTION_TABLES, createTestDatabase, seedPerson, schema, DERIVATION_VERSION,
  NoteStore, EventStore,
} from '../src/index.ts'
import type { TestDatabase } from '../src/index.ts'

const NINE_AM = Date.UTC(2026, 7, 1, 9, 0)

let test: TestDatabase
let dir: string

beforeEach(() => {
  test = createTestDatabase()
  dir = mkdtempSync(join(tmpdir(), 'proj-'))
  seedPerson(test.db, 'alice')
  seedPerson(test.db, 'bart')
  for (const p of ['alice', 'bart'] as const) {
    test.db.insert(schema.sources).values({
      id: `${p}-watch`, personId: p, externalId: `${p}-watch`,
      displayName: `${p}'s watch`, kind: 'device', createdAtMs: 0,
    }).run()
    test.db.insert(schema.daily).values({
      personId: p, localDate: '2026-08-01', metric: 'steps', agg: 'sum', source: 'merged',
      value: p === 'alice' ? 1200 : 8800, coverage: 0.9, sourceMix: null,
      derivationVersion: DERIVATION_VERSION, updatedAtMs: 0,
    }).run()
    test.db.insert(schema.sessions).values({
      id: `${p}-run`, personId: p, sourceId: `${p}-watch`, kind: 'exercise', externalId: `${p}-run`,
      startMs: NINE_AM, startOffsetMinutes: 0, endMs: NINE_AM + 3_600_000, endOffsetMinutes: 0,
      localDate: '2026-08-01', attrs: '{"a":1}', rawPayloadId: null,
    }).run()
    new NoteStore(test.db).put({ personId: p, localDate: '2026-08-01', body: `${p}-note-sentinel`, nowMs: 0 })
    new EventStore(test.db).add({
      personId: p, kind: 'illness', startedAtMs: NINE_AM, startedAtOffsetMinutes: 0,
      note: `${p}-event-sentinel`,
    })
  }
})

afterEach(() => {
  test.cleanup()
  rmSync(dir, { recursive: true, force: true })
})

/** Opens the written projection and hands back a reader, plus its own closer. */
function openProjection(personId: string) {
  const path = join(dir, `${personId}.db`)
  new PersonQuery(test.db, personId).writeProjection(path)
  const db = new Database(path, { readonly: true })
  return { db, close: () => db.close() }
}

describe('the projection', () => {
  it('holds exactly the seven declared tables and nothing else', () => {
    const { db, close } = openProjection('alice')
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map((r) => (r as { name: string }).name)
    close()
    expect(names).toEqual([...PROJECTION_TABLES].sort())
  })

  it('contains no table that holds a credential', () => {
    const { db, close } = openProjection('alice')
    const names = db.prepare("SELECT name FROM sqlite_master").all()
      .map((r) => (r as { name: string }).name)
    close()
    // Named one by one rather than as a count: these four are the reason the projection exists
    // at all, and a future table that joins them should fail this line by name.
    for (const forbidden of ['accounts', 'credentials', 'mcp_tokens', 'auth_sessions']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('has no person_id column on any table, because there is only one person in the file', () => {
    const { db, close } = openProjection('alice')
    const offenders: string[] = []
    for (const table of PROJECTION_TABLES) {
      const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()
        .map((r) => (r as { name: string }).name)
      if (cols.includes('person_id')) offenders.push(table)
    }
    close()
    expect(offenders).toEqual([])
  })

  it("carries alice's rows and none of bart's", () => {
    const { db, close } = openProjection('alice')
    const dump = JSON.stringify({
      daily: db.prepare('SELECT * FROM daily').all(),
      sessions: db.prepare('SELECT * FROM sessions').all(),
      notes: db.prepare('SELECT * FROM notes').all(),
      events: db.prepare('SELECT * FROM events').all(),
      sources: db.prepare('SELECT * FROM sources').all(),
    })
    close()
    expect(dump).toContain('alice-note-sentinel')
    expect(dump).toContain('1200')
    for (const fingerprint of ['bart', 'bart-note-sentinel', 'bart-event-sentinel', '8800']) {
      expect(dump).not.toContain(fingerprint)
    }
  })

  it('resolves a session source to its name and drops raw_payload_id', () => {
    const { db, close } = openProjection('alice')
    const cols = db.prepare("SELECT name FROM pragma_table_info('sessions')").all()
      .map((r) => (r as { name: string }).name)
    const row = db.prepare('SELECT source_name FROM sessions').get() as { source_name: string }
    close()
    expect(cols).toContain('source_name')
    expect(cols).not.toContain('source_id')
    expect(cols).not.toContain('raw_payload_id')
    expect(row.source_name).toBe("alice's watch")
  })

  it('overwrites rather than appending when the same path is written twice', () => {
    const path = join(dir, 'twice.db')
    new PersonQuery(test.db, 'alice').writeProjection(path)
    new PersonQuery(test.db, 'alice').writeProjection(path)
    const db = new Database(path, { readonly: true })
    const n = (db.prepare('SELECT count(*) AS n FROM daily').get() as { n: number }).n
    db.close()
    expect(n).toBe(1)
  })
})
