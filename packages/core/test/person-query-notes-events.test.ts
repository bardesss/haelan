import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { NoteStore } from '../src/store/notes.ts'
import { EventStore } from '../src/store/events.ts'
import { ConfigError } from '../src/errors.ts'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'robin')
  seedPerson(test.db, 'sam')
})
afterEach(() => test.cleanup())

describe('PersonQuery.notes', () => {
  beforeEach(() => {
    const notes = new NoteStore(test.db)
    notes.put({ personId: 'robin', localDate: '2026-08-10', body: 'slept badly, cold coming on', nowMs: 0 })
    notes.put({ personId: 'robin', localDate: '2026-08-20', body: 'long ride, legs fine', nowMs: 0 })
    notes.put({ personId: 'sam', localDate: '2026-08-10', body: 'sam wrote this', nowMs: 0 })
  })

  it('answers only the bound person, oldest first', () => {
    const q = new PersonQuery(test.db, 'robin')
    expect(q.notes({ from: '2026-08-01', to: '2026-08-31' }).map((n) => n.localDate))
      .toEqual(['2026-08-10', '2026-08-20'])
  })

  it('never answers another person, even for the same date', () => {
    const q = new PersonQuery(test.db, 'robin')
    const bodies = q.notes({ from: '2026-08-01', to: '2026-08-31' }).map((n) => n.body)
    expect(bodies.join(' ')).not.toContain('sam wrote this')
  })

  it('filters on text, case insensitively', () => {
    const q = new PersonQuery(test.db, 'robin')
    expect(q.notes({ from: '2026-08-01', to: '2026-08-31', contains: 'COLD' }).map((n) => n.localDate))
      .toEqual(['2026-08-10'])
  })

  it('refuses a range whose dates are not dates', () => {
    const q = new PersonQuery(test.db, 'robin')
    expect(() => q.notes({ from: '2026-8-1', to: '2026-08-31' })).toThrow(ConfigError)
  })
})

describe('PersonQuery.events', () => {
  beforeEach(() => {
    const events = new EventStore(test.db)
    events.add({
      personId: 'robin', kind: 'illness', startedAtMs: Date.UTC(2026, 7, 10, 9),
      startedAtOffsetMinutes: 120, note: 'fever',
    })
    events.add({
      personId: 'sam', kind: 'illness', startedAtMs: Date.UTC(2026, 7, 10, 9),
      startedAtOffsetMinutes: 120, note: 'sam is ill',
    })
  })

  it('answers only the bound person', () => {
    const q = new PersonQuery(test.db, 'robin')
    const rows = q.events({ from: '2026-08-01', to: '2026-08-31' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.note).toBe('fever')
  })

  it('refuses a backwards range', () => {
    const q = new PersonQuery(test.db, 'robin')
    expect(() => q.events({ from: '2026-08-31', to: '2026-08-01' })).toThrow(/is after to/)
  })
})
