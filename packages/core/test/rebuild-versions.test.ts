import { afterEach, describe, expect, test } from 'vitest'
import { MAPPING_VERSION, DERIVATION_VERSION, peopleNeedingRebuild } from '../src/index.ts'
import { PeopleStore } from '../src/store/people.ts'
import type { PersonRow } from '../src/store/people.ts'
import { createTestDatabase } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

const person = (over: Partial<PersonRow> = {}): PersonRow => ({
  id: 'p1',
  displayName: 'Ada',
  timezone: 'Europe/Amsterdam',
  birthDate: null,
  sex: null,
  companionPath: false,
  builtMappingVersion: MAPPING_VERSION,
  builtDerivationVersion: DERIVATION_VERSION,
  ...over,
})

describe('peopleNeedingRebuild', () => {
  test('a person stamped at the current versions needs nothing', () => {
    expect(peopleNeedingRebuild([person()])).toEqual([])
  })

  test('unstamped rows need a rebuild for both layers', () => {
    const need = peopleNeedingRebuild([
      person({ builtMappingVersion: null, builtDerivationVersion: null }),
    ])
    expect(need).toHaveLength(1)
    expect(need[0]!.personId).toBe('p1')
    expect(need[0]!.reasons).toEqual([
      `mapping version unrecorded, now ${MAPPING_VERSION}`,
      `derivation version unrecorded, now ${DERIVATION_VERSION}`,
    ])
  })

  test('a stale mapping version is reported on its own', () => {
    const need = peopleNeedingRebuild([person({ builtMappingVersion: MAPPING_VERSION - 1 })])
    expect(need[0]!.reasons).toEqual([
      `mapping version ${MAPPING_VERSION - 1}, now ${MAPPING_VERSION}`,
    ])
  })

  test('a stale derivation version is reported on its own', () => {
    const need = peopleNeedingRebuild([person({ builtDerivationVersion: 1 })])
    expect(need[0]!.reasons).toEqual([`derivation version 1, now ${DERIVATION_VERSION}`])
  })

  test('only the people who need it are returned', () => {
    const need = peopleNeedingRebuild([
      person({ id: 'fresh' }),
      person({ id: 'stale', builtDerivationVersion: 1 }),
    ])
    expect(need.map((n) => n.personId)).toEqual(['stale'])
  })

  test('no people means no rebuild', () => {
    expect(peopleNeedingRebuild([])).toEqual([])
  })
})

describe('a person the wizard just created', () => {
  let t: TestDatabase | null = null
  afterEach(() => { t?.cleanup(); t = null })

  test('is stamped at the current versions, so nothing thinks they need rebuilding', () => {
    t = createTestDatabase()
    const store = new PeopleStore(t.db)

    const created = store.create({
      id: 'p1', displayName: 'Ada', timezone: 'Europe/Amsterdam', nowMs: 1,
    })

    // A person with no derived rows at all is trivially consistent with any version, so this is
    // an honest stamp rather than a convenient lie. It is also what makes the sync gate mean
    // what it says: the runner skips people who need a rebuild, and a brand new person left
    // unstamped would be reported as needing one, be skipped, and never receive any data. The
    // rebuild only runs at boot, so nothing would ever have cleared it either.
    expect(created.builtMappingVersion).toBe(MAPPING_VERSION)
    expect(created.builtDerivationVersion).toBe(DERIVATION_VERSION)
    // Read back, not just returned. What the gate consults is the row, and a create that
    // returned the stamp without writing it would pass on the object alone.
    expect(peopleNeedingRebuild(store.list())).toEqual([])
  })
})
