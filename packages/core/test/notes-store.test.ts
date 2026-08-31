import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { NoteStore } from '../src/store/notes.ts'

let test: TestDatabase
let notes: NoteStore

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  notes = new NoteStore(test.db)
})
afterEach(() => test.cleanup())

describe('NoteStore', () => {
  it('writes a note and reads it back in range', () => {
    notes.put({ personId: 'p1', localDate: '2026-08-15', body: 'flew to Tokyo', nowMs: 1000 })
    expect(notes.listFor('p1', '2026-08-01', '2026-08-31'))
      .toMatchObject([{ localDate: '2026-08-15', body: 'flew to Tokyo' }])
  })

  // The schema's own unique constraint says one note per person per day, so a second write is an
  // edit rather than a second row. Without the upsert this throws and the reader loses the edit.
  it('replaces the day\'s note rather than adding a second', () => {
    notes.put({ personId: 'p1', localDate: '2026-08-15', body: 'first', nowMs: 1000 })
    notes.put({ personId: 'p1', localDate: '2026-08-15', body: 'second', nowMs: 2000 })
    const rows = notes.listFor('p1', '2026-08-01', '2026-08-31')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.body).toBe('second')
    expect(rows[0]!.updatedAtMs).toBe(2000)
  })

  // Section 15: an account touches only its own person's data. A store that filtered on date alone
  // would pass every other test in this file.
  it('never returns or overwrites another person\'s note', () => {
    seedPerson(test.db, 'p2')
    notes.put({ personId: 'p1', localDate: '2026-08-15', body: 'mine', nowMs: 1000 })
    notes.put({ personId: 'p2', localDate: '2026-08-15', body: 'theirs', nowMs: 1000 })
    expect(notes.listFor('p1', '2026-08-01', '2026-08-31')).toHaveLength(1)
    expect(notes.listFor('p1', '2026-08-01', '2026-08-31')[0]!.body).toBe('mine')
  })

  it('removes only the named day and only for that person', () => {
    seedPerson(test.db, 'p2')
    notes.put({ personId: 'p1', localDate: '2026-08-15', body: 'mine', nowMs: 1000 })
    notes.put({ personId: 'p2', localDate: '2026-08-15', body: 'theirs', nowMs: 1000 })
    notes.remove({ personId: 'p1', localDate: '2026-08-15' })
    expect(notes.listFor('p1', '2026-08-01', '2026-08-31')).toHaveLength(0)
    expect(notes.listFor('p2', '2026-08-01', '2026-08-31')).toHaveLength(1)
  })

  it('excludes a note outside the requested range', () => {
    notes.put({ personId: 'p1', localDate: '2026-07-31', body: 'before', nowMs: 1000 })
    notes.put({ personId: 'p1', localDate: '2026-09-01', body: 'after', nowMs: 1000 })
    expect(notes.listFor('p1', '2026-08-01', '2026-08-31')).toHaveLength(0)
  })
})
