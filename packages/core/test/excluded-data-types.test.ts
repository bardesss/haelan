import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { ExcludedDataTypeStore } from '../src/store/excludedDataTypes.ts'

let test: TestDatabase
let store: ExcludedDataTypeStore
const NOW = 1_770_000_000_000

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  seedPerson(test.db, 'p2')
  store = new ExcludedDataTypeStore(test.db)
})
afterEach(() => test.cleanup())

describe('listFor', () => {
  // The whole design rests on this: an empty set means everything is on, so a data type added to
  // the catalogue tomorrow is on for everybody who already installed.
  it('is empty for a person who has chosen nothing', () => {
    expect(store.listFor('p1')).toEqual([])
  })

  it('returns what was set, sorted', () => {
    store.setFor({ personId: 'p1', dataTypeIds: ['hydration-log', 'floors'], nowMs: NOW })
    expect(store.listFor('p1')).toEqual(['floors', 'hydration-log'])
  })
})

describe('setFor', () => {
  it('replaces the whole set rather than adding to it', () => {
    store.setFor({ personId: 'p1', dataTypeIds: ['floors', 'hydration-log'], nowMs: NOW })
    store.setFor({ personId: 'p1', dataTypeIds: ['floors'], nowMs: NOW + 1 })
    expect(store.listFor('p1')).toEqual(['floors'])
  })

  it('clears everything when given an empty list', () => {
    store.setFor({ personId: 'p1', dataTypeIds: ['floors'], nowMs: NOW })
    store.setFor({ personId: 'p1', dataTypeIds: [], nowMs: NOW + 1 })
    expect(store.listFor('p1')).toEqual([])
  })

  it('leaves another person\'s choices alone', () => {
    store.setFor({ personId: 'p1', dataTypeIds: ['floors'], nowMs: NOW })
    store.setFor({ personId: 'p2', dataTypeIds: ['hydration-log'], nowMs: NOW })
    expect(store.listFor('p1')).toEqual(['floors'])
    expect(store.listFor('p2')).toEqual(['hydration-log'])
  })

  // The id is deliberately not a foreign key: the catalogue is code, so a type removed from it
  // should leave a harmless orphan rather than block a migration.
  it('accepts an id the catalogue does not declare', () => {
    store.setFor({ personId: 'p1', dataTypeIds: ['a-type-that-no-longer-exists'], nowMs: NOW })
    expect(store.listFor('p1')).toEqual(['a-type-that-no-longer-exists'])
  })
})

describe('isExcluded', () => {
  it('answers per person and per type', () => {
    store.setFor({ personId: 'p1', dataTypeIds: ['floors'], nowMs: NOW })
    expect(store.isExcluded('p1', 'floors')).toBe(true)
    expect(store.isExcluded('p1', 'steps')).toBe(false)
    expect(store.isExcluded('p2', 'floors')).toBe(false)
  })
})
