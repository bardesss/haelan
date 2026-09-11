import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readSession } from '../src/query/sessions.ts'
import { overrides, sessions, sources } from '../src/db/schema/index.ts'

let t: TestDatabase
beforeEach(() => {
  t = createTestDatabase()
  seedPerson(t.db, 'p1')
  seedPerson(t.db, 'p2')
  for (const [id, personId] of [['watch', 'p1'], ['their-watch', 'p2']] as const) {
    t.db.insert(sources).values({
      id, personId, externalId: id, displayName: id, kind: 'device', createdAtMs: 0,
    }).run()
  }
})
afterEach(() => t.cleanup())

const insert = (o: { id: string, personId?: string, sourceId?: string, attrs?: unknown }) =>
  t.db.insert(sessions).values({
    id: o.id, personId: o.personId ?? 'p1', sourceId: o.sourceId ?? 'watch',
    kind: 'exercise', externalId: o.id,
    startMs: 1_000_000, startOffsetMinutes: 120, endMs: 1_060_000, endOffsetMinutes: 120,
    localDate: '2026-08-18', attrs: JSON.stringify(o.attrs ?? { exerciseType: 'RUNNING' }),
    rawPayloadId: null,
  }).run()

describe('readSession', () => {
  it('returns the session, with attrs already parsed', () => {
    insert({ id: 'run1', attrs: { exerciseType: 'RUNNING', displayName: 'Evening Run' } })

    const out = readSession(t.db, { personId: 'p1', sessionId: 'run1' })

    expect(out).not.toBeNull()
    expect(out?.id).toBe('run1')
    expect(out?.sourceId).toBe('watch')
    expect(out?.startMs).toBe(1_000_000)
    expect(out?.endMs).toBe(1_060_000)
    expect(out?.localDate).toBe('2026-08-18')
    // Parsed, not a string: every caller of readSessions already gets a value, and a by-id read
    // that handed back raw JSON would make the two readers disagree about their own return type.
    expect(out?.attrs).toEqual({ exerciseType: 'RUNNING', displayName: 'Evening Run' })
  })

  it('returns null for an id that does not exist', () => {
    expect(readSession(t.db, { personId: 'p1', sessionId: 'nope' })).toBeNull()
  })

  it("returns null for another person's session, so the route can answer 404 rather than 403", () => {
    insert({ id: 'their-run', personId: 'p2', sourceId: 'their-watch' })

    // The row exists. Scoping by person as well as id inside the query is what makes a 403
    // impossible to leak by accident: the route never learns the difference between "no such
    // session" and "not yours", so it cannot accidentally tell a caller which one it was.
    expect(readSession(t.db, { personId: 'p1', sessionId: 'their-run' })).toBeNull()
    expect(readSession(t.db, { personId: 'p2', sessionId: 'their-run' })).not.toBeNull()
  })

  it('carries the exclusion and its reason, the same way the list reader does', () => {
    insert({ id: 'run1' })
    t.db.insert(overrides).values({
      id: 'o1', personId: 'p1', scope: 'session', targetKey: JSON.stringify({ session: 'run1' }),
      action: 'exclude', reason: 'forgot to stop the timer', correctedValue: null, createdAtMs: 0,
    }).run()

    const out = readSession(t.db, { personId: 'p1', sessionId: 'run1' })
    expect(out?.excluded).toBe(true)
    expect(out?.excludeReason).toBe('forgot to stop the timer')
  })

  it('reports a session nobody excluded as not excluded, with no reason', () => {
    insert({ id: 'run1' })
    const out = readSession(t.db, { personId: 'p1', sessionId: 'run1' })
    expect(out?.excluded).toBe(false)
    expect(out?.excludeReason).toBeNull()
  })

  it('returns a session of either kind, since the id already names exactly one row', () => {
    t.db.insert(sessions).values({
      id: 'night1', personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: 'night1',
      startMs: 1, startOffsetMinutes: 120, endMs: 2, endOffsetMinutes: 120,
      localDate: '2026-08-18', attrs: '{}', rawPayloadId: null,
    }).run()

    // No kind filter here, unlike readSessions, where kind is load bearing because a range read
    // of one kind would otherwise answer with the other's rows too. An id is already unique
    // across both kinds, so demanding a kind would only let a caller get it wrong.
    expect(readSession(t.db, { personId: 'p1', sessionId: 'night1' })?.id).toBe('night1')
  })
})
