import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase } from '../src/testing/fixtures.ts'
import { PeopleStore, effectiveTimezone } from '../src/store/people.ts'
import { peopleNeedingRebuild } from '../src/rebuild/versions.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'

describe('effectiveTimezone', () => {
  const home = { timezone: 'Europe/Amsterdam', currentTimezone: 'Asia/Tokyo', followPhoneZone: true }

  it('follows the phone when the switch is on and the zone is set', () => {
    expect(effectiveTimezone(home)).toBe('Asia/Tokyo')
  })
  it('stays home when the switch is off', () => {
    expect(effectiveTimezone({ ...home, followPhoneZone: false })).toBe('Europe/Amsterdam')
  })
  it('stays home when no phone has sent a zone', () => {
    expect(effectiveTimezone({ ...home, currentTimezone: null })).toBe('Europe/Amsterdam')
  })
  it('stays home when the stored zone is one Intl does not know', () => {
    expect(effectiveTimezone({ ...home, currentTimezone: 'Mars/Olympus_Mons' })).toBe('Europe/Amsterdam')
  })
})

describe('the phone zone on a person', () => {
  let test: ReturnType<typeof createTestDatabase>
  let people: PeopleStore
  beforeEach(() => {
    test = createTestDatabase()
    people = new PeopleStore(test.db)
    people.create({ id: 'p1', displayName: 'R', timezone: 'Europe/Amsterdam', nowMs: 1 })
  })
  afterEach(() => test.cleanup())

  it('starts with no current zone and following on, and create() says so', () => {
    expect(people.get('p1')).toMatchObject({ currentTimezone: null, followPhoneZone: true })
    expect(people.create({ id: 'p2', displayName: 'S', timezone: 'UTC', nowMs: 1 }))
      .toMatchObject({ currentTimezone: null, followPhoneZone: true })
  })

  it('stores a current zone, reports whether it wrote, and leaves the home zone alone', () => {
    expect(people.setCurrentTimezone('p1', 'Asia/Tokyo')).toBe(true)
    expect(people.get('p1')).toMatchObject({ timezone: 'Europe/Amsterdam', currentTimezone: 'Asia/Tokyo' })
    expect(people.list().find((p) => p.id === 'p1')!.currentTimezone).toBe('Asia/Tokyo')
    // The same zone again writes nothing, which is what an ingest per chunk relies on.
    expect(people.setCurrentTimezone('p1', 'Asia/Tokyo')).toBe(false)
    expect(people.setCurrentTimezone('p1', 'America/New_York')).toBe(true)
    expect(people.get('p1')!.currentTimezone).toBe('America/New_York')
  })

  it('refuses a zone Intl does not know', () => {
    expect(() => people.setCurrentTimezone('p1', 'Mars/Olympus_Mons')).toThrow(/unknown timezone/)
    expect(people.get('p1')!.currentTimezone).toBeNull()
  })

  it('turns following off and on', () => {
    people.setFollowPhoneZone('p1', false)
    expect(people.get('p1')!.followPhoneZone).toBe(false)
    people.setFollowPhoneZone('p1', true)
    expect(people.get('p1')!.followPhoneZone).toBe(true)
    expect(() => people.setFollowPhoneZone('p1', 'yes' as unknown as boolean)).toThrow(/boolean/)
  })

  it('clears no derivation stamp and marks no rebuild, unlike setTimezone', () => {
    people.setCurrentTimezone('p1', 'Asia/Tokyo')
    people.setFollowPhoneZone('p1', false)
    expect(people.get('p1')!.builtDerivationVersion).toBe(DERIVATION_VERSION)
    expect(peopleNeedingRebuild(people.list())).toEqual([])
    // The contrast that makes the assertions above mean something: the home zone does mark one.
    people.setTimezone('p1', 'Asia/Tokyo')
    expect(peopleNeedingRebuild(people.list()).map((n) => n.personId)).toEqual(['p1'])
  })
})
