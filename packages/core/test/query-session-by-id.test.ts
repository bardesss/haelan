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

// The same row, of whichever of the three kinds the table holds. `insert` above always writes an
// exercise row, which is the interesting one for attrs; this one exists so the kind is the only
// thing a test varies.
const insertOfKind = (o: {
  id: string, kind: 'sleep' | 'exercise' | 'ecg', personId?: string, sourceId?: string,
}) =>
  t.db.insert(sessions).values({
    id: o.id, personId: o.personId ?? 'p1', sourceId: o.sourceId ?? 'watch',
    kind: o.kind, externalId: o.id,
    startMs: 1, startOffsetMinutes: 120, endMs: 2, endOffsetMinutes: 120,
    localDate: '2026-08-18', attrs: '{}', rawPayloadId: null,
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

  it('returns a sleep session as well as an exercise one, with no kind asked for', () => {
    insertOfKind({ id: 'night1', kind: 'sleep' })

    // No kind parameter here, unlike readSessions, where the caller's kind is load bearing
    // because a range read of one kind would otherwise answer with the other's rows too. An id
    // is already unique, so demanding a kind would only let a caller get it wrong.
    expect(readSession(t.db, { personId: 'p1', sessionId: 'night1' })?.id).toBe('night1')
  })

  it('returns null for an ecg id, which the list route refuses for the same reason', () => {
    insertOfKind({ id: 'ecg1', kind: 'ecg' })

    // The row exists and belongs to this person. It is still null, because WorkoutSession cannot
    // say anything true about an ECG: no classification, no waveform, and every exercise attr
    // null. tier2.ts refuses kind=ecg on the list route, and a by-id read answering one would
    // have made the two routes disagree about whether an ECG is readable at all.
    expect(readSession(t.db, { personId: 'p1', sessionId: 'ecg1' })).toBeNull()
  })

  it('answers an ecg id exactly as it answers a nonexistent one, so the two cannot be told apart', () => {
    insertOfKind({ id: 'ecg1', kind: 'ecg' })
    insertOfKind({ id: 'their-ecg', personId: 'p2', sourceId: 'their-watch', kind: 'ecg' })

    // Three different reasons for null - unreadable kind, nothing there, somebody else's row -
    // and one indistinguishable answer, which is what lets the route send one 404 envelope for
    // all three. A refusal that threw, or returned a distinct marker, would tell a caller that
    // an id they are not entitled to know about exists.
    const ownEcg = readSession(t.db, { personId: 'p1', sessionId: 'ecg1' })
    const missing = readSession(t.db, { personId: 'p1', sessionId: 'nope' })
    const theirs = readSession(t.db, { personId: 'p1', sessionId: 'their-ecg' })
    expect(ownEcg).toBeNull()
    expect(missing).toBeNull()
    expect(theirs).toBeNull()
  })
})
