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
    expect(readSessions(test.db, { personId: 'p1', ...RANGE, type: 'RUNNING', last: 1 }).map((s) => s.id))
      .toEqual(['run-2'])
  })

  it('latest with no match answers nothing rather than the wrong session', () => {
    expect(readSessions(test.db, { personId: 'p1', ...RANGE, type: 'SWIMMING', last: 1 })).toEqual([])
  })

  it('last answers the N most recent matches, oldest first within them', () => {
    expect(readSessions(test.db, { personId: 'p1', ...RANGE, type: 'RUNNING', last: 2 }).map((s) => s.id))
      .toEqual(['run-1', 'run-2'])
  })

  it('refuses a last that is not a positive integer', () => {
    const q = new PersonQuery(test.db, 'p1')
    expect(() => q.sessions({ ...RANGE, last: 0 })).toThrow(ConfigError)
    expect(() => q.sessions({ ...RANGE, last: 1.5 })).toThrow(/positive integer/)
  })

  it('a session with no exercise type is never matched by a type filter', () => {
    expect(readSessions(test.db, { personId: 'p1', ...RANGE, type: 'RUNNING' }).map((s) => s.id))
      .not.toContain('unknown')
  })
})

describe('PersonQuery.sessions', () => {
  // Three sessions, arranged so that each forwarded field is the only thing standing between this
  // assertion and a different answer. One session would have made the test unfailable: it is the
  // whole list, the most recent, and the only run at once, so dropping either `type` or `last`
  // from the pass-through would still answer it and nothing would go red.
  //
  // The ride is deliberately the most recent of the three rather than the earliest. With an
  // earlier ride, `last` alone still lands on run-2 and a dropped `type` stays invisible.
  beforeEach(() => {
    addSession({ id: 'run-1', localDate: '2026-08-12', startMs: Date.UTC(2026, 7, 12, 7), exerciseType: 'RUNNING' })
    addSession({ id: 'run-2', localDate: '2026-08-20', startMs: Date.UTC(2026, 7, 20, 7), exerciseType: 'RUNNING' })
    addSession({ id: 'ride', localDate: '2026-08-25', startMs: Date.UTC(2026, 7, 25, 7), exerciseType: 'BIKING' })
  })

  it('passes the filters through', () => {
    const q = new PersonQuery(test.db, 'p1')
    // Dropping `type` answers ['ride']; dropping `last` answers ['run-1', 'run-2'].
    expect(q.sessions({ ...RANGE, type: 'RUNNING', last: 1 }).map((s) => s.id)).toEqual(['run-2'])
  })

  it('answers the whole list when neither narrowing field is given', () => {
    // The other half of the pass-through: a forwarded field that is undefined must not become a
    // filter. Without this, a reader hard-coding `last: 1` would pass the test above.
    const q = new PersonQuery(test.db, 'p1')
    expect(q.sessions({ ...RANGE }).map((s) => s.id)).toEqual(['run-1', 'run-2', 'ride'])
  })

  // The cast is the point rather than a workaround: this is what an HTTP query string and a
  // model's tool arguments actually deliver, and the type annotation does not reach either of
  // them. `1` is dropped from the values under test here (it was the old boolean coercion's
  // interesting case; as a `last` it is simply a valid count of 1, covered above), and `true` and
  // `null` still reach `requireOptionalPositiveInteger` as values the type system would have
  // refused, exactly as an HTTP query string or a model's tool call can actually deliver them.
  it.each([['the string "1"', '1'], ['true', true], ['null', null]])(
    'refuses %s for last rather than reading it as no filter',
    (_label, value) => {
      const q = new PersonQuery(test.db, 'p1')
      const input = { ...RANGE, last: value } as unknown as Parameters<PersonQuery['sessions']>[0]
      expect(() => q.sessions(input)).toThrow(ConfigError)
      expect(() => q.sessions(input)).toThrow(/positive integer/)
    },
  )

  it('refuses an exercise type the provider has no such value for', () => {
    const q = new PersonQuery(test.db, 'p1')
    expect(() => q.sessions({ ...RANGE, type: 'JOGGING' })).toThrow(ConfigError)
    expect(() => q.sessions({ ...RANGE, type: 'JOGGING' })).toThrow(/no exercise type named 'JOGGING'/)
  })

  // A real exercise type against the wrong kind. Both arguments are individually valid, which is
  // what made this the one combination that got through: the type passes requireExerciseType, the
  // kind passes requireSessionKind, and the reader then matches no row for any range in any
  // household. An agent handed that empty list says the person has not run, which is a confident
  // false statement about somebody's health record - the thing this class throws to avoid.
  it("refuses an exercise type against kind 'sleep' rather than answering nothing", () => {
    const q = new PersonQuery(test.db, 'p1')
    const input = { kind: 'sleep' as const, from: '2026-08-01', to: '2026-08-31', type: 'RUNNING' }
    expect(() => q.sessions(input)).toThrow(ConfigError)
    expect(() => q.sessions(input)).toThrow(/no exercise type to filter on/)
  })

  it("still answers kind 'sleep' with no type", () => {
    // The other half: the refusal is about the pair, not about sleep, and must not have closed
    // the plain sleep listing this branch's own barrel test depends on.
    const q = new PersonQuery(test.db, 'p1')
    expect(q.sessions({ kind: 'sleep', from: '2026-08-01', to: '2026-08-31' })).toEqual([])
  })
})
