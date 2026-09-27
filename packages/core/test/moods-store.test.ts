import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { MoodStore } from '../src/store/moods.ts'

let test: ReturnType<typeof createTestDatabase>
let moods: MoodStore
beforeEach(() => { test = createTestDatabase(); seedPerson(test.db, 'p1'); seedPerson(test.db, 'p2'); moods = new MoodStore(test.db) })
afterEach(() => test.cleanup())

describe('MoodStore', () => {
  it('upserts one score per person per day', () => {
    moods.put({ personId: 'p1', localDate: '2026-09-20', score: 2, nowMs: 1 })
    moods.put({ personId: 'p1', localDate: '2026-09-20', score: 4, nowMs: 2 })
    expect(moods.get('p1', '2026-09-20')).toBe(4)
    expect(moods.listFor('p1', '2026-09-01', '2026-09-30')).toEqual([{ localDate: '2026-09-20', score: 4, updatedAtMs: 2 }])
  })
  it('keeps people apart', () => {
    moods.put({ personId: 'p2', localDate: '2026-09-20', score: 1, nowMs: 1 })
    expect(moods.get('p1', '2026-09-20')).toBeNull()
  })
  it('removes, and lists a range oldest first', () => {
    moods.put({ personId: 'p1', localDate: '2026-09-21', score: 3, nowMs: 1 })
    moods.put({ personId: 'p1', localDate: '2026-09-19', score: 5, nowMs: 1 })
    moods.put({ personId: 'p1', localDate: '2026-10-01', score: 5, nowMs: 1 })
    expect(moods.listFor('p1', '2026-09-01', '2026-09-30').map((m) => m.localDate)).toEqual(['2026-09-19', '2026-09-21'])
    moods.remove({ personId: 'p1', localDate: '2026-09-21' })
    expect(moods.get('p1', '2026-09-21')).toBeNull()
  })
  it('refuses a score outside 1-5 or not an integer', () => {
    expect(() => moods.put({ personId: 'p1', localDate: '2026-09-20', score: 0, nowMs: 1 })).toThrow(/score must be an integer from 1 to 5/)
    expect(() => moods.put({ personId: 'p1', localDate: '2026-09-20', score: 6, nowMs: 1 })).toThrow(/score/)
    expect(() => moods.put({ personId: 'p1', localDate: '2026-09-20', score: 2.5, nowMs: 1 })).toThrow(/score/)
  })
})
