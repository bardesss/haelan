import { describe, expect, test } from 'vitest'
import { MAPPING_VERSION, DERIVATION_VERSION, peopleNeedingRebuild } from '../src/index.ts'
import type { PersonRow } from '../src/store/people.ts'

const person = (over: Partial<PersonRow> = {}): PersonRow => ({
  id: 'p1',
  displayName: 'Ada',
  timezone: 'Europe/Amsterdam',
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
