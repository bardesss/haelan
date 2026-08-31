import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { EventStore } from '../src/store/events.ts'

let test: TestDatabase
let events: EventStore

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  events = new EventStore(test.db)
})
afterEach(() => test.cleanup())

describe('EventStore', () => {
  it('adds an event and reads it back in range', () => {
    events.add({ personId: 'p1', kind: 'travel', startedAtMs: 2000, startedAtOffsetMinutes: 120 })
    expect(events.listFor('p1', 1000, 3000)).toMatchObject([{ kind: 'travel', startedAtMs: 2000 }])
  })

  // The schema comment names six seed kinds and says the column is deliberately not an enum, so a
  // store that rejected an unknown kind would be enforcing a rule the schema chose not to make.
  it('accepts a kind outside the seed set', () => {
    events.add({ personId: 'p1', kind: 'dentist', startedAtMs: 2000, startedAtOffsetMinutes: 0 })
    expect(events.listFor('p1', 1000, 3000)[0]!.kind).toBe('dentist')
  })

  it('keeps an optional end, value and note, and nulls them when absent', () => {
    events.add({
      personId: 'p1', kind: 'alcohol', startedAtMs: 2000, startedAtOffsetMinutes: 0,
      endedAtMs: 2500, endedAtOffsetMinutes: 0, value: 3, note: 'two glasses',
    })
    events.add({ personId: 'p1', kind: 'illness', startedAtMs: 2100, startedAtOffsetMinutes: 0 })
    const rows = events.listFor('p1', 1000, 3000)
    expect(rows.find((r) => r.kind === 'alcohol')).toMatchObject({ endedAtMs: 2500, value: 3, note: 'two glasses' })
    expect(rows.find((r) => r.kind === 'illness')).toMatchObject({ endedAtMs: null, value: null, note: null })
  })

  // Section 15: an account touches only its own person's data. A store that filtered on time
  // range alone would pass every other test in this file.
  it('never returns another person\'s event', () => {
    seedPerson(test.db, 'p2')
    events.add({ personId: 'p1', kind: 'travel', startedAtMs: 2000, startedAtOffsetMinutes: 0 })
    events.add({ personId: 'p2', kind: 'illness', startedAtMs: 2000, startedAtOffsetMinutes: 0 })
    expect(events.listFor('p1', 1000, 3000)).toHaveLength(1)
  })

  // An id is not a secret. OverrideStore.remove scopes by personId as well as id for exactly this
  // reason, and its comment says so. Unlike a note, an event carries no other key alongside its
  // id, so this is the only guard standing between a held id and someone else's row.
  it('refuses to remove another person\'s event even given its id', () => {
    seedPerson(test.db, 'p2')
    const theirs = events.add({ personId: 'p2', kind: 'illness', startedAtMs: 2000, startedAtOffsetMinutes: 0 })
    events.remove({ personId: 'p1', id: theirs })
    expect(events.listFor('p2', 1000, 3000)).toHaveLength(1)
  })

  it('removes the named event for its own person', () => {
    const mine = events.add({ personId: 'p1', kind: 'travel', startedAtMs: 2000, startedAtOffsetMinutes: 0 })
    events.remove({ personId: 'p1', id: mine })
    expect(events.listFor('p1', 1000, 3000)).toHaveLength(0)
  })

  // A test that only seeds rows outside the range proves a filter exists but not which side of
  // the boundary it falls on. gte/lte are inclusive, so an event started exactly at fromMs or
  // exactly at toMs has to come back; a regression to exclusive bounds would drop both and pass
  // every other test in this file.
  it('includes an event started exactly on either end of the range', () => {
    events.add({ personId: 'p1', kind: 'travel', startedAtMs: 1000, startedAtOffsetMinutes: 0 })
    events.add({ personId: 'p1', kind: 'illness', startedAtMs: 3000, startedAtOffsetMinutes: 0 })
    const rows = events.listFor('p1', 1000, 3000)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.startedAtMs)).toEqual([1000, 3000])
  })

  it('excludes an event outside the requested range', () => {
    events.add({ personId: 'p1', kind: 'travel', startedAtMs: 999, startedAtOffsetMinutes: 0 })
    events.add({ personId: 'p1', kind: 'illness', startedAtMs: 3001, startedAtOffsetMinutes: 0 })
    expect(events.listFor('p1', 1000, 3000)).toHaveLength(0)
  })
})
