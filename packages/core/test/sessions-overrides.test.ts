import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { readSessions } from '../src/query/sessions.ts'
import { OverrideStore } from '../src/store/overrides.ts'
import { DeriveQueue } from '../src/store/deriveQueue.ts'
import { sessions, sources } from '../src/db/schema/index.ts'
import { dayMetricTarget, sessionTarget } from '../src/derive/targetKey.ts'

let test: TestDatabase
let overrides: OverrideStore

const START = Date.UTC(2026, 7, 21, 8, 0)

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({
    id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).run()
  test.db.insert(sessions).values([
    { id: 's1', personId: 'p1', sourceId: 'watch', kind: 'exercise', externalId: 's1', startMs: START, endMs: START + 1_800_000,
      startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-21', attrs: '{}', rawPayloadId: null },
    { id: 's2', personId: 'p1', sourceId: 'watch', kind: 'exercise', externalId: 's2', startMs: START + 3_600_000, endMs: START + 5_400_000,
      startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-08-21', attrs: '{}', rawPayloadId: null },
  ]).run()
  overrides = new OverrideStore(test.db, new DeriveQueue(test.db))
})
afterEach(() => test.cleanup())

const read = () => readSessions(test.db, { personId: 'p1', kind: 'exercise', from: '2026-08-21', to: '2026-08-21' })

describe('readSessions and overrides', () => {
  it('reports every session as included when nothing is excluded', () => {
    expect(read().map((s) => ({ id: s.id, excluded: s.excluded, excludeReason: s.excludeReason })))
      .toEqual([
        { id: 's1', excluded: false, excludeReason: null },
        { id: 's2', excluded: false, excludeReason: null },
      ])
  })

  // Marked, not dropped: the count card above the list already excludes this row at derivation,
  // and a list that silently agreed would leave a reader no way to see what they threw out.
  it('marks an excluded session and keeps it in the list', () => {
    overrides.put({
      personId: 'p1', scope: 'session', targetKey: sessionTarget('s1'),
      action: 'exclude', reason: 'strap fell off', nowMs: 1_000,
    })
    expect(read().map((s) => ({ id: s.id, excluded: s.excluded, excludeReason: s.excludeReason })))
      .toEqual([
        { id: 's1', excluded: true, excludeReason: 'strap fell off' },
        { id: 's2', excluded: false, excludeReason: null },
      ])
  })

  it('does not apply another person\'s override', () => {
    seedPerson(test.db, 'p2')
    new OverrideStore(test.db, new DeriveQueue(test.db)).put({
      personId: 'p2', scope: 'session', targetKey: sessionTarget('s1'),
      action: 'exclude', reason: 'theirs', nowMs: 1_000,
    })
    expect(read().every((s) => !s.excluded)).toBe(true)
  })

  // A day_metric or sample override says nothing about a session and must not touch this list.
  it('ignores overrides at other scopes', () => {
    overrides.put({
      personId: 'p1', scope: 'day_metric', targetKey: dayMetricTarget({ localDate: '2026-08-21', metric: 'steps' }),
      action: 'exclude', reason: 'not a session', nowMs: 1_000,
    })
    expect(read().every((s) => !s.excluded)).toBe(true)
  })
})
