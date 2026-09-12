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
    test.db.insert(schema.sessionSegments).values({
      id: `${p}-segment-sentinel`, sessionId: `${p}-run`, stage: 'light',
      startMs: NINE_AM, endMs: NINE_AM + 1_800_000,
    }).run()
    test.db.insert(schema.observations).values({
      id: `${p}-obs-sentinel`, personId: p, sourceId: `${p}-watch`, kind: 'mood',
      startedAtMs: NINE_AM, startedAtOffsetMinutes: 0, localDate: '2026-08-01',
      value: `${p}-observation-sentinel`,
    }).run()
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
      sessionSegments: db.prepare('SELECT * FROM session_segments').all(),
      notes: db.prepare('SELECT * FROM notes').all(),
      events: db.prepare('SELECT * FROM events').all(),
      observations: db.prepare('SELECT * FROM observations').all(),
      sources: db.prepare('SELECT * FROM sources').all(),
    })
    close()
    expect(dump).toContain('alice-note-sentinel')
    expect(dump).toContain('1200')
    expect(dump).toContain('alice-segment-sentinel')
    expect(dump).toContain('alice-observation-sentinel')
    // The join that resolves observations.source_name is the one Finding 1 scoped: this is the
    // assertion that would fail if `AND src.person_id = ?` were ever dropped from it, rather than
    // only the SQL saying so.
    expect(dump).toContain("alice's watch")
    for (const fingerprint of [
      'bart', 'bart-note-sentinel', 'bart-event-sentinel', '8800',
      'bart-segment-sentinel', 'bart-observation-sentinel', "bart's watch",
    ]) {
      expect(dump).not.toContain(fingerprint)
    }
  })

  it('refuses to resolve a source name across people even if a row is corrupted to point at one', () => {
    // sessions.source_id and observations.source_id are plain foreign keys into sources.id, a
    // global primary key - nothing at the schema level stops a session from pointing at another
    // person's source. The only thing that keeps them aligned today is an application-level
    // invariant in SourceRegistry, which this test deliberately breaks to prove the join itself
    // still refuses to resolve the stranger's name rather than depending on that invariant.
    test.db.insert(schema.sessions).values({
      id: 'alice-corrupt-run', personId: 'alice', sourceId: 'bart-watch', kind: 'exercise',
      externalId: 'alice-corrupt-run', startMs: NINE_AM, startOffsetMinutes: 0,
      endMs: NINE_AM + 3_600_000, endOffsetMinutes: 0, localDate: '2026-08-01', attrs: '{}',
      rawPayloadId: null,
    }).run()
    test.db.insert(schema.observations).values({
      id: 'alice-corrupt-obs', personId: 'alice', sourceId: 'bart-watch', kind: 'mood',
      startedAtMs: NINE_AM, startedAtOffsetMinutes: 0, localDate: '2026-08-01',
      value: 'alice-corrupt-obs-value',
    }).run()

    const { db, close } = openProjection('alice')
    const session = db.prepare("SELECT source_name FROM sessions WHERE id = 'alice-corrupt-run'")
      .get() as { source_name: string | null }
    const observation = db.prepare("SELECT source_name FROM observations WHERE id = 'alice-corrupt-obs'")
      .get() as { source_name: string | null }
    close()
    expect(session.source_name).toBeNull()
    expect(observation.source_name).toBeNull()
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
