import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readSessions } from '../src/query/sessions.ts'
import { sessions, sources } from '../src/db/schema/index.ts'
import type { SessionKind } from '../src/db/schema/index.ts'

const H = 3_600_000
// 23:00 local on 2026-08-21 at +120 is 21:00Z, so the night starts before the date it belongs to.
const BEDTIME = Date.UTC(2026, 7, 21, 21, 0)

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({
    id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch',
    kind: 'device', createdAtMs: 0,
  }).run()
})
afterEach(() => test.cleanup())

// One helper taking a kind, rather than two near copies of an insert for sleep and for exercise.
const rawInsertSession = (o: {
  id: string, kind: SessionKind, startMs: number, endMs: number, localDate: string, attrs?: unknown,
}) =>
  test.db.insert(sessions).values({
    id: o.id, personId: 'p1', sourceId: 'watch', kind: o.kind, externalId: o.id,
    startMs: o.startMs, startOffsetMinutes: 120, endMs: o.endMs, endOffsetMinutes: 120,
    localDate: o.localDate, attrs: JSON.stringify(o.attrs ?? { mainSleep: true }), rawPayloadId: null,
  }).run()

const insertSession = (o: { id: string, startMs: number, endMs: number, localDate: string }) =>
  rawInsertSession({ ...o, kind: 'sleep' })

const insertExercise = (o: { id: string, startMs: number, endMs: number, localDate: string, attrs?: unknown }) =>
  rawInsertSession({ ...o, kind: 'exercise', attrs: o.attrs ?? {} })

describe('readSessions', () => {
  it('returns exercise sessions in the range, oldest first', () => {
    insertExercise({ id: 'evening', startMs: BEDTIME - 4 * H, endMs: BEDTIME - 3 * H, localDate: '2026-08-21' })
    insertExercise({ id: 'morning', startMs: BEDTIME - 14 * H, endMs: BEDTIME - 13 * H, localDate: '2026-08-21' })

    const out = readSessions(test.db, { personId: 'p1', kind: 'exercise', from: '2026-08-21', to: '2026-08-21' })
    expect(out.map((s) => s.id)).toEqual(['morning', 'evening'])
  })

  // The two kinds share one table and one index. A read that forgot the kind filter would report
  // last night as a workout.
  it('keeps sleep out of an exercise read, and the reverse', () => {
    insertExercise({ id: 'run', startMs: BEDTIME - 4 * H, endMs: BEDTIME - 3 * H, localDate: '2026-08-21' })
    insertSession({ id: 'night', startMs: BEDTIME, endMs: BEDTIME + 8 * H, localDate: '2026-08-22' })

    expect(readSessions(test.db, { personId: 'p1', kind: 'exercise', from: '2026-08-21', to: '2026-08-22' })
      .map((s) => s.id)).toEqual(['run'])
    expect(readSessions(test.db, { personId: 'p1', kind: 'sleep', from: '2026-08-21', to: '2026-08-22' })
      .map((s) => s.id)).toEqual(['night'])
  })

  // attrs is stored as a JSON string. Handing that to a caller makes every caller parse it, and
  // one of them will forget and render "[object Object]" or crash on a null.
  it('parses attrs rather than handing back a JSON string', () => {
    insertExercise({
      id: 'run', startMs: BEDTIME - 4 * H, endMs: BEDTIME - 3 * H, localDate: '2026-08-21',
      attrs: { activityType: 'RUNNING' },
    })
    expect(readSessions(test.db, { personId: 'p1', kind: 'exercise', from: '2026-08-21', to: '2026-08-21' })[0]?.attrs)
      .toEqual({ activityType: 'RUNNING' })
  })

  // Two devices can report an exercise session starting at the exact same instant. Ordering by
  // startMs alone leaves that tie to whatever order sqlite happened to return the rows in, which
  // flaps a snapshot or an ETag built from this list without anything in the data actually
  // changing.
  it('breaks a startMs tie with a total order, not an arbitrary one', () => {
    insertExercise({ id: 'b-run', startMs: BEDTIME, endMs: BEDTIME + H, localDate: '2026-08-22' })
    insertExercise({ id: 'a-run', startMs: BEDTIME, endMs: BEDTIME + H, localDate: '2026-08-22' })

    const out = readSessions(test.db, { personId: 'p1', kind: 'exercise', from: '2026-08-22', to: '2026-08-22' })
    expect(out.map((s) => s.id)).toEqual(['a-run', 'b-run'])
  })

  // The mapper is what would normally write attrs, so malformed JSON should never reach this
  // table, but a reader that trusted that and threw on the day it turned out false would take the
  // whole page down with it. Inserted directly because insertExercise always JSON.stringifies.
  it('returns null attrs rather than throwing when the stored JSON is malformed', () => {
    test.db.insert(sessions).values({
      id: 'bad', personId: 'p1', sourceId: 'watch', kind: 'exercise', externalId: 'bad',
      startMs: BEDTIME - 4 * H, startOffsetMinutes: 120, endMs: BEDTIME - 3 * H, endOffsetMinutes: 120,
      localDate: '2026-08-21', attrs: 'not json', rawPayloadId: null,
    }).run()

    const out = readSessions(test.db, { personId: 'p1', kind: 'exercise', from: '2026-08-21', to: '2026-08-21' })
    expect(out[0]?.attrs).toBeNull()
  })
})
