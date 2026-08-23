import { afterEach, describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { retargetOverrides } from '../src/rebuild/retarget.ts'
import { overrides } from '../src/db/schema/index.ts'
import { sampleTarget, sessionTarget, dayMetricTarget } from '../src/derive/targetKey.ts'

import {
  createTestDatabase, seedPerson, seedSample, seedSession, seedOverride,
} from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

let t: TestDatabase
afterEach(() => { t.cleanup() })
const freshDb = (): TestDatabase['db'] => { t = createTestDatabase(); return t.db }

const keyOf = (db: TestDatabase['db'], id: string): string =>
  db.select().from(overrides).where(eq(overrides.id, id)).get()!.targetKey

describe('retargetOverrides', () => {
  test('a sample override follows its instant onto the new source', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    seedSample(db, { personId: 'p1', sourceId: 'new-source', metric: 'heart_rate', utcMs: 1000 })
    const id = seedOverride(db, {
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'old-source', metric: 'heart_rate', utcMs: 1000 }),
    })

    const outcome = retargetOverrides(db, { personId: 'p1', oldSessions: new Map() })

    expect(outcome.retargeted).toBe(1)
    expect(outcome.orphaned).toEqual([])
    expect(keyOf(db, id)).toBe(sampleTarget({ source: 'new-source', metric: 'heart_rate', utcMs: 1000 }))
  })

  test('an override already pointing at the surviving source is left alone', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    seedSample(db, { personId: 'p1', sourceId: 'same', metric: 'heart_rate', utcMs: 1000 })
    const key = sampleTarget({ source: 'same', metric: 'heart_rate', utcMs: 1000 })
    seedOverride(db, { personId: 'p1', scope: 'sample', targetKey: key })

    const outcome = retargetOverrides(db, { personId: 'p1', oldSessions: new Map() })

    expect(outcome).toEqual({ retargeted: 0, orphaned: [] })
  })

  test('two sources at one instant is ambiguous, so the override is reported', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    seedSample(db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: 1000 })
    seedSample(db, { personId: 'p1', sourceId: 'phone', metric: 'heart_rate', utcMs: 1000 })
    seedOverride(db, {
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'old', metric: 'heart_rate', utcMs: 1000 }),
    })

    const outcome = retargetOverrides(db, { personId: 'p1', oldSessions: new Map() })

    expect(outcome.retargeted).toBe(0)
    expect(outcome.orphaned).toHaveLength(1)
    expect(outcome.orphaned[0]!.reason).toBe('two or more sources report that instant')
  })

  test('three rows from one source at one instant is still one answer', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    // What per-minute downsampling actually writes: three rows, one per aggregate, same person,
    // source, metric and instant. Counting rows instead of distinct sources would see three and
    // call this ambiguous, when there is exactly one source here.
    seedSample(db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: 1000, agg: 'min' })
    seedSample(db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: 1000, agg: 'mean' })
    seedSample(db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: 1000, agg: 'max' })
    const id = seedOverride(db, {
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'old-source', metric: 'heart_rate', utcMs: 1000 }),
    })

    const outcome = retargetOverrides(db, { personId: 'p1', oldSessions: new Map() })

    expect(outcome.retargeted).toBe(1)
    expect(outcome.orphaned).toEqual([])
    expect(keyOf(db, id)).toBe(sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: 1000 }))
  })

  test('no sample at that instant is reported', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    seedOverride(db, {
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'old', metric: 'heart_rate', utcMs: 1000 }),
    })

    const outcome = retargetOverrides(db, { personId: 'p1', oldSessions: new Map() })

    expect(outcome.orphaned[0]!.reason).toBe('no sample at that instant')
  })

  test('a session override follows its external id', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    seedSession(db, { id: 'new-session', personId: 'p1', kind: 'sleep', externalId: 'night-1' })
    const id = seedOverride(db, {
      personId: 'p1', scope: 'session', targetKey: sessionTarget('old-session'),
    })

    const outcome = retargetOverrides(db, {
      personId: 'p1',
      oldSessions: new Map([['old-session', { kind: 'sleep', externalId: 'night-1' }]]),
    })

    expect(outcome.retargeted).toBe(1)
    expect(keyOf(db, id)).toBe(sessionTarget('new-session'))
  })

  test('a session the rebuild did not reproduce is reported', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    seedOverride(db, {
      personId: 'p1', scope: 'session', targetKey: sessionTarget('old-session'),
    })

    const outcome = retargetOverrides(db, {
      personId: 'p1',
      oldSessions: new Map([['old-session', { kind: 'sleep', externalId: 'night-1' }]]),
    })

    expect(outcome.orphaned[0]!.reason).toBe('no session with that external id survived')
  })

  test('a day metric override has no source in its key and is untouched', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    const key = dayMetricTarget({ localDate: '2026-08-01', metric: 'steps' })
    const id = seedOverride(db, { personId: 'p1', scope: 'day_metric', targetKey: key })

    const outcome = retargetOverrides(db, { personId: 'p1', oldSessions: new Map() })

    expect(outcome).toEqual({ retargeted: 0, orphaned: [] })
    expect(keyOf(db, id)).toBe(key)
  })

  test('a move that would collide with another override is reported, not forced', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    seedSample(db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: 1000 })
    const surviving = sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: 1000 })
    seedOverride(db, { personId: 'p1', scope: 'sample', targetKey: surviving })
    seedOverride(db, {
      personId: 'p1', scope: 'sample',
      targetKey: sampleTarget({ source: 'old', metric: 'heart_rate', utcMs: 1000 }),
    })

    const outcome = retargetOverrides(db, { personId: 'p1', oldSessions: new Map() })

    expect(outcome.retargeted).toBe(0)
    expect(outcome.orphaned).toHaveLength(1)
    expect(outcome.orphaned[0]!.reason).toBe('another override already points there')
  })

  test('another person\'s overrides are not touched', () => {
    const db = freshDb()
    seedPerson(db, 'p1')
    seedPerson(db, 'p2')
    seedSample(db, { personId: 'p1', sourceId: 'watch', metric: 'heart_rate', utcMs: 1000 })
    const theirs = sampleTarget({ source: 'old', metric: 'heart_rate', utcMs: 1000 })
    const id = seedOverride(db, { personId: 'p2', scope: 'sample', targetKey: theirs })

    retargetOverrides(db, { personId: 'p1', oldSessions: new Map() })

    expect(keyOf(db, id)).toBe(theirs)
  })
})
