import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readSessions } from '../src/query/sessions.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { ConfigError } from '../src/errors.ts'
import { sessions, sources } from '../src/db/schema/index.ts'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({
    id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).run()
})
afterEach(() => test.cleanup())

function addSession(o: { id: string, localDate: string, startMs: number, exerciseType: string | null }): void {
  test.db.insert(sessions).values({
    id: o.id,
    personId: 'p1',
    sourceId: 'watch',
    kind: 'exercise',
    externalId: o.id,
    startMs: o.startMs,
    startOffsetMinutes: 120,
    endMs: o.startMs + 45 * 60_000,
    endOffsetMinutes: 120,
    localDate: o.localDate,
    attrs: JSON.stringify({ exerciseType: o.exerciseType, metricsSummary: { caloriesKcal: 400 } }),
  }).run()
}

const RANGE = { kind: 'exercise' as const, from: '2026-08-01', to: '2026-08-31' }

describe('readSessions filters', () => {
  beforeEach(() => {
    addSession({ id: 'ride', localDate: '2026-08-10', startMs: Date.UTC(2026, 7, 10, 7), exerciseType: 'BIKING' })
    addSession({ id: 'run-1', localDate: '2026-08-12', startMs: Date.UTC(2026, 7, 12, 7), exerciseType: 'RUNNING' })
    addSession({ id: 'run-2', localDate: '2026-08-20', startMs: Date.UTC(2026, 7, 20, 7), exerciseType: 'RUNNING' })
    addSession({ id: 'unknown', localDate: '2026-08-22', startMs: Date.UTC(2026, 7, 22, 7), exerciseType: null })
  })

  it('returns every session in range when no type is given', () => {
    expect(readSessions(test.db, { personId: 'p1', ...RANGE }).map((s) => s.id))
      .toEqual(['ride', 'run-1', 'run-2', 'unknown'])
  })

  it('keeps only the named exercise type', () => {
    expect(readSessions(test.db, { personId: 'p1', ...RANGE, type: 'RUNNING' }).map((s) => s.id))
      .toEqual(['run-1', 'run-2'])
  })

  it('latest answers the most recent one, after the type filter', () => {
    expect(readSessions(test.db, { personId: 'p1', ...RANGE, type: 'RUNNING', latest: true }).map((s) => s.id))
      .toEqual(['run-2'])
  })

  it('latest with no match answers nothing rather than the wrong session', () => {
    expect(readSessions(test.db, { personId: 'p1', ...RANGE, type: 'SWIMMING', latest: true })).toEqual([])
  })

  it('a session with no exercise type is never matched by a type filter', () => {
    expect(readSessions(test.db, { personId: 'p1', ...RANGE, type: 'RUNNING' }).map((s) => s.id))
      .not.toContain('unknown')
  })
})

describe('PersonQuery.sessions', () => {
  it('passes the filters through', () => {
    addSession({ id: 'run-1', localDate: '2026-08-12', startMs: Date.UTC(2026, 7, 12, 7), exerciseType: 'RUNNING' })
    const q = new PersonQuery(test.db, 'p1')
    expect(q.sessions({ ...RANGE, type: 'RUNNING', latest: true }).map((s) => s.id)).toEqual(['run-1'])
  })

  it('refuses an exercise type the provider has no such value for', () => {
    const q = new PersonQuery(test.db, 'p1')
    expect(() => q.sessions({ ...RANGE, type: 'JOGGING' })).toThrow(ConfigError)
    expect(() => q.sessions({ ...RANGE, type: 'JOGGING' })).toThrow(/no exercise type named 'JOGGING'/)
  })
})
