import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { EventStore } from '../src/store/events.ts'
import { localDateOf, widenedUtcWindow } from '../src/derive/localDay.ts'

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
    events.add({
      personId: 'p1', kind: 'travel', startedAtMs: Date.parse('2026-08-15T09:00:00Z'), startedAtOffsetMinutes: 0,
    })
    expect(events.listFor('p1', '2026-08-15', '2026-08-15')).toMatchObject([{ kind: 'travel' }])
  })

  // The schema comment names six seed kinds and says the column is deliberately not an enum, so a
  // store that rejected an unknown kind would be enforcing a rule the schema chose not to make.
  it('accepts a kind outside the seed set', () => {
    events.add({
      personId: 'p1', kind: 'dentist', startedAtMs: Date.parse('2026-08-15T09:00:00Z'), startedAtOffsetMinutes: 0,
    })
    expect(events.listFor('p1', '2026-08-15', '2026-08-15')[0]!.kind).toBe('dentist')
  })

  it('keeps an optional end, value and note, and nulls them when absent', () => {
    events.add({
      personId: 'p1', kind: 'alcohol', startedAtMs: Date.parse('2026-08-15T09:00:00Z'), startedAtOffsetMinutes: 0,
      endedAtMs: Date.parse('2026-08-15T10:00:00Z'), endedAtOffsetMinutes: 0, value: 3, note: 'two glasses',
    })
    events.add({
      personId: 'p1', kind: 'illness', startedAtMs: Date.parse('2026-08-15T11:00:00Z'), startedAtOffsetMinutes: 0,
    })
    const rows = events.listFor('p1', '2026-08-15', '2026-08-15')
    expect(rows.find((r) => r.kind === 'alcohol')).toMatchObject({
      endedAtMs: Date.parse('2026-08-15T10:00:00Z'), endedAtOffsetMinutes: 0, value: 3, note: 'two glasses',
    })
    expect(rows.find((r) => r.kind === 'illness')).toMatchObject({ endedAtMs: null, value: null, note: null })
  })

  // ?? rather than || is what lets a recorded zero come back as zero instead of collapsing to the
  // same null as never having been given at all, and 3 above is truthy so it cannot catch a
  // regression to ||. A caffeine event with value 0 (decaf, or none) is a real reading, and a
  // zero offset is UTC, a real timezone rather than a missing one; either falling back to null
  // would silently turn a recorded zero into an absent value.
  it('keeps a value of zero and an offset of zero rather than treating them as absent', () => {
    events.add({
      personId: 'p1', kind: 'caffeine', startedAtMs: Date.parse('2026-08-15T09:00:00Z'), startedAtOffsetMinutes: 0,
      endedAtMs: Date.parse('2026-08-15T09:00:00Z'), endedAtOffsetMinutes: 0, value: 0, note: 'decaf',
    })
    const row = events.listFor('p1', '2026-08-15', '2026-08-15')[0]!
    expect(row.value).toBe(0)
    expect(row.startedAtOffsetMinutes).toBe(0)
    expect(row.endedAtOffsetMinutes).toBe(0)
  })

  // Section 15: an account touches only its own person's data. A store that filtered on time
  // range alone would pass every other test in this file.
  it('never returns another person\'s event', () => {
    seedPerson(test.db, 'p2')
    events.add({
      personId: 'p1', kind: 'travel', startedAtMs: Date.parse('2026-08-15T09:00:00Z'), startedAtOffsetMinutes: 0,
    })
    events.add({
      personId: 'p2', kind: 'illness', startedAtMs: Date.parse('2026-08-15T09:00:00Z'), startedAtOffsetMinutes: 0,
    })
    expect(events.listFor('p1', '2026-08-15', '2026-08-15')).toHaveLength(1)
  })

  // An id is not a secret. OverrideStore.remove scopes by personId as well as id for exactly this
  // reason, and its comment says so. Unlike a note, an event carries no other key alongside its
  // id, so this is the only guard standing between a held id and someone else's row.
  it('refuses to remove another person\'s event even given its id', () => {
    seedPerson(test.db, 'p2')
    const theirs = events.add({
      personId: 'p2', kind: 'illness', startedAtMs: Date.parse('2026-08-15T09:00:00Z'), startedAtOffsetMinutes: 0,
    })
    events.remove({ personId: 'p1', id: theirs })
    expect(events.listFor('p2', '2026-08-15', '2026-08-15')).toHaveLength(1)
  })

  it('removes the named event for its own person', () => {
    const mine = events.add({
      personId: 'p1', kind: 'travel', startedAtMs: Date.parse('2026-08-15T09:00:00Z'), startedAtOffsetMinutes: 0,
    })
    events.remove({ personId: 'p1', id: mine })
    expect(events.listFor('p1', '2026-08-15', '2026-08-15')).toHaveLength(0)
  })

  // A test that only seeds rows outside the range proves a filter exists but not which side of
  // the boundary it falls on. The range is inclusive of both endpoint local dates, so an event on
  // the first instant of `from` and one on the last instant of `to` both have to come back; a
  // regression to exclusive bounds would drop both and pass every other test in this file.
  it('includes an event started exactly on either end of the range, at offset zero', () => {
    events.add({
      personId: 'p1', kind: 'at-start', startedAtMs: Date.parse('2026-08-01T00:00:00.000Z'), startedAtOffsetMinutes: 0,
    })
    events.add({
      personId: 'p1', kind: 'at-end', startedAtMs: Date.parse('2026-08-10T23:59:59.999Z'), startedAtOffsetMinutes: 0,
    })
    const rows = events.listFor('p1', '2026-08-01', '2026-08-10')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.kind).sort()).toEqual(['at-end', 'at-start'])
  })

  it('excludes an event outside the requested range, at offset zero', () => {
    events.add({
      personId: 'p1', kind: 'before', startedAtMs: Date.parse('2026-07-31T23:59:59.999Z'), startedAtOffsetMinutes: 0,
    })
    events.add({
      personId: 'p1', kind: 'after', startedAtMs: Date.parse('2026-08-02T00:00:00.000Z'), startedAtOffsetMinutes: 0,
    })
    expect(events.listFor('p1', '2026-08-01', '2026-08-01')).toHaveLength(0)
  })

  // The case a plain UTC window gets wrong: this instant sits inside the widened UTC scan
  // (well within widenedUtcWindow('2026-08-01')) but its own offset puts local midnight on
  // 2026-08-01 fourteen hours before this UTC instant, so a narrower, unwidened fetch would have
  // missed it outright. localDateOf is what listFor narrows by, and asserted here directly rather
  // than hand-computed, so the seeded instant's local date is pinned to what the store itself uses.
  it('includes an event whose own offset puts it inside the local range', () => {
    const startedAtOffsetMinutes = 120 // UTC+2
    const startedAtMs = Date.parse('2026-07-31T22:30:00Z') // 2026-08-01T00:30 local
    expect(localDateOf(startedAtMs, startedAtOffsetMinutes)).toBe('2026-08-01')
    events.add({ personId: 'p1', kind: 'travel', startedAtMs, startedAtOffsetMinutes })
    expect(events.listFor('p1', '2026-08-01', '2026-08-01')).toMatchObject([{ kind: 'travel', localDate: '2026-08-01' }])
  })

  // The mirror case: an instant inside the widened UTC scan whose own offset puts its local date
  // outside the requested range, which is exactly what the per-row narrowing exists to catch. The
  // widened window is asserted first so the instant chosen is provably inside the wide SQL fetch,
  // not merely inside some window this test guessed at.
  it('excludes an event whose own offset puts it outside, though its instant is inside the widened window', () => {
    const { start: windowStart, end: windowEnd } = widenedUtcWindow('2026-08-01')
    const startedAtOffsetMinutes = -120 // UTC-2
    const startedAtMs = Date.parse('2026-08-01T01:00:00Z') // 2026-07-31T23:00 local
    expect(startedAtMs).toBeGreaterThanOrEqual(windowStart)
    expect(startedAtMs).toBeLessThanOrEqual(windowEnd)
    expect(localDateOf(startedAtMs, startedAtOffsetMinutes)).toBe('2026-07-31')
    events.add({ personId: 'p1', kind: 'travel', startedAtMs, startedAtOffsetMinutes })
    expect(events.listFor('p1', '2026-08-01', '2026-08-01')).toHaveLength(0)
  })

  // The offset is the event's own, not the person's current one: somebody who has moved keeps the
  // offset each event was recorded under. Two events share one UTC instant here; only their
  // offsets differ, and that difference alone has to be what decides which one is in range.
  it('uses each event\'s own offset rather than one shared value', () => {
    const startedAtMs = Date.parse('2026-08-01T01:00:00Z')
    events.add({ personId: 'p1', kind: 'still-here', startedAtMs, startedAtOffsetMinutes: 120 }) // 03:00 local, 2026-08-01
    events.add({ personId: 'p1', kind: 'moved-since', startedAtMs, startedAtOffsetMinutes: -120 }) // 23:00 local, 2026-07-31
    expect(localDateOf(startedAtMs, 120)).toBe('2026-08-01')
    expect(localDateOf(startedAtMs, -120)).toBe('2026-07-31')
    const rows = events.listFor('p1', '2026-08-01', '2026-08-01')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('still-here')
  })

  // A real offset in this codebase, not a rounding convenience: some zones sit 30 or 45 minutes
  // off the hour. One event lands a millisecond before local midnight, the other exactly at it;
  // only the offset tells them apart, and localDateOf is asserted directly rather than assumed.
  it('handles a non-whole-hour offset at a local day boundary', () => {
    const startedAtOffsetMinutes = 90 // UTC+1:30
    const beforeMidnightMs = Date.parse('2026-07-31T23:59:59.999Z') - startedAtOffsetMinutes * 60_000
    const atMidnightMs = Date.parse('2026-08-01T00:00:00.000Z') - startedAtOffsetMinutes * 60_000
    expect(localDateOf(beforeMidnightMs, startedAtOffsetMinutes)).toBe('2026-07-31')
    expect(localDateOf(atMidnightMs, startedAtOffsetMinutes)).toBe('2026-08-01')
    events.add({ personId: 'p1', kind: 'before-boundary', startedAtMs: beforeMidnightMs, startedAtOffsetMinutes })
    events.add({ personId: 'p1', kind: 'at-boundary', startedAtMs: atMidnightMs, startedAtOffsetMinutes })
    const rows = events.listFor('p1', '2026-08-01', '2026-08-01')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('at-boundary')
  })
})
