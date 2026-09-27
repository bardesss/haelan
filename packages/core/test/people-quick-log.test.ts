import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase } from '../src/testing/fixtures.ts'
import { PeopleStore, quickLogPresetsOf } from '../src/store/people.ts'
import { SEED_KINDS } from '../src/api/eventKinds.ts'

let test: ReturnType<typeof createTestDatabase>
let people: PeopleStore
beforeEach(() => { test = createTestDatabase(); people = new PeopleStore(test.db); people.create({ id: 'p1', displayName: 'R', timezone: 'Europe/Amsterdam', nowMs: 1 }) })
afterEach(() => test.cleanup())

describe('quick logging on a person', () => {
  it('is off by default, and create() says so', () => {
    expect(people.get('p1')!.quickLogEnabled).toBe(false)
    expect(people.create({ id: 'p2', displayName: 'S', timezone: 'UTC', nowMs: 1 }).quickLogEnabled).toBe(false)
  })
  it('turns on and off', () => {
    people.setQuickLogEnabled('p1', true)
    expect(people.get('p1')!.quickLogEnabled).toBe(true)
    expect(people.list().find((p) => p.id === 'p1')!.quickLogEnabled).toBe(true)
  })
  it('reads the seed kinds until a list is saved, and an empty list as empty', () => {
    expect(people.get('p1')!.quickLogPresets).toBeNull()
    expect(quickLogPresetsOf(people.get('p1')!)).toEqual(SEED_KINDS)
    people.setQuickLogPresets('p1', ['sauna', ' alcohol'])
    expect(quickLogPresetsOf(people.get('p1')!)).toEqual(['sauna', 'alcohol'])
    people.setQuickLogPresets('p1', [])
    expect(quickLogPresetsOf(people.get('p1')!)).toEqual([])
  })
  it('validates what it stores', () => {
    expect(() => people.setQuickLogPresets('p1', ['a', 'A'])).toThrow(/repeats/)
  })
})
