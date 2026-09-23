import { afterEach, describe, expect, it } from 'vitest'
import { createTestDatabase } from '../src/testing/fixtures.ts'
import { PeopleStore } from '../src/store/people.ts'
import { DEFAULT_SLEEP_TARGET_MINUTES, SLEEP_TARGET_MINUTES_RANGE } from '../src/derive/metrics.ts'
// Open a migrated database the way the neighbouring store tests do, and build a PeopleStore over
// it. Do not hand-roll a schema here: the point of this test is that migration 0018 ran.

// Every database this file opens, so afterEach can close it and take its temp directory down.
// freshPerson used to drop the fixture on the floor: the handle stayed open until the worker
// exited and the directory under %TEMP% was never removed, so a full suite run left one
// haelan-test-* behind per test in here - the largest single source of the thousand-odd that had
// accumulated on a development machine. A list rather than a single slot because nothing stops a
// later test calling freshPerson twice, and the version that tracked one fixture would leak the
// first one again without anything going red.
const openDatabases: Array<() => void> = []

// Closes the handle before removing the directory, which is the order Windows requires: an open
// SQLite handle makes the directory un-unlinkable, and the EPERM that rmSync then throws would be
// reported instead of whatever the test was actually failing on.
afterEach(() => { for (const cleanup of openDatabases.splice(0)) cleanup() })

function freshPerson() {
  const fixture = createTestDatabase()
  openDatabases.push(fixture.cleanup)
  const store = new PeopleStore(fixture.db)
  const person = store.create({
    id: 'p1', displayName: 'p1', timezone: 'Europe/Amsterdam', nowMs: 0,
  })
  return { store, personId: person.id }
}

describe('the profile fields that feed a cardio load', () => {
  it('starts null for a person the wizard just created', () => {
    const { store, personId } = freshPerson()
    const person = store.get(personId)!
    expect(person.birthDate).toBeNull()
    expect(person.sex).toBeNull()
  })

  it('stores and reads back a birthday', () => {
    const { store, personId } = freshPerson()
    store.setBirthDate(personId, '1985-03-04')
    expect(store.get(personId)!.birthDate).toBe('1985-03-04')
  })

  it('stores and reads back a sex', () => {
    const { store, personId } = freshPerson()
    store.setSex(personId, 'female')
    expect(store.get(personId)!.sex).toBe('female')
  })

  it('clears either field back to null', () => {
    const { store, personId } = freshPerson()
    store.setBirthDate(personId, '1985-03-04')
    store.setSex(personId, 'male')
    store.setBirthDate(personId, null)
    store.setSex(personId, null)
    const person = store.get(personId)!
    expect(person.birthDate).toBeNull()
    expect(person.sex).toBeNull()
  })

  it('refuses a birthday that is not a local date', () => {
    const { store, personId } = freshPerson()
    expect(() => store.setBirthDate(personId, '4 March 1985')).toThrow()
  })

  it('refuses a birthday in the future', () => {
    const { store, personId } = freshPerson()
    expect(() => store.setBirthDate(personId, '2099-01-01')).toThrow()
  })

  // The whole reason these two columns cost nothing: no stored derived row reads them. Banister
  // is computed at read time on a workout, so a birthday edit invalidates nothing and must not
  // clear the stamp the way setTimezone deliberately does.
  it('leaves the derivation stamp alone, unlike a timezone move', () => {
    const { store, personId } = freshPerson()
    const before = store.get(personId)!.builtDerivationVersion
    store.setBirthDate(personId, '1985-03-04')
    store.setSex(personId, 'male')
    expect(store.get(personId)!.builtDerivationVersion).toBe(before)
  })
})

describe('the sleep target, the first stored preference beyond the profile fields', () => {
  it('answers eight hours on a person the wizard just created', () => {
    const { store, personId } = freshPerson()
    expect(store.get(personId)!.sleepTargetMinutes).toBe(DEFAULT_SLEEP_TARGET_MINUTES)
    // The number itself, not only the constant: a renamed constant that took a new value with it
    // would keep this test green while every existing person's card moved its zero line.
    expect(DEFAULT_SLEEP_TARGET_MINUTES).toBe(480)
  })

  it('stores a target and reads it back', () => {
    const { store, personId } = freshPerson()
    store.setSleepTargetMinutes(personId, 450)
    expect(store.get(personId)!.sleepTargetMinutes).toBe(450)
  })

  it('refuses a target under the floor and above the ceiling', () => {
    const { store, personId } = freshPerson()
    expect(() => store.setSleepTargetMinutes(personId, SLEEP_TARGET_MINUTES_RANGE.min - 1)).toThrow()
    expect(() => store.setSleepTargetMinutes(personId, SLEEP_TARGET_MINUTES_RANGE.max + 1)).toThrow()
    // The refusal has to leave the stored value where it was, not write and then complain.
    expect(store.get(personId)!.sleepTargetMinutes).toBe(DEFAULT_SLEEP_TARGET_MINUTES)
  })

  // 8 is eight hours typed into a field that wanted minutes. Accepting it would put a zero line
  // eight minutes above the floor of every night that person ever recorded.
  it('refuses a target that is not whole minutes', () => {
    const { store, personId } = freshPerson()
    expect(() => store.setSleepTargetMinutes(personId, 450.5)).toThrow()
    expect(store.get(personId)!.sleepTargetMinutes).toBe(DEFAULT_SLEEP_TARGET_MINUTES)
  })

  it('accepts both ends of the range', () => {
    const { store, personId } = freshPerson()
    store.setSleepTargetMinutes(personId, SLEEP_TARGET_MINUTES_RANGE.min)
    expect(store.get(personId)!.sleepTargetMinutes).toBe(60)
    store.setSleepTargetMinutes(personId, SLEEP_TARGET_MINUTES_RANGE.max)
    expect(store.get(personId)!.sleepTargetMinutes).toBe(1080)
  })

  // The same assertion setBirthDate carries, for the same reason: the sleep balance card computes
  // at read time from this column, so nothing stored has to be rebuilt when it moves.
  it('leaves the derivation stamp alone, because nothing derived reads it', () => {
    const { store, personId } = freshPerson()
    const before = store.get(personId)!.builtDerivationVersion
    store.setSleepTargetMinutes(personId, 450)
    expect(store.get(personId)!.builtDerivationVersion).toBe(before)
  })
})

describe('the baseline switch beside the sleep target', () => {
  it('follows the baseline on a person the wizard just created', () => {
    const { store, personId } = freshPerson()
    expect(store.get(personId)!.sleepUseBaseline).toBe(true)
  })

  it('stores the switch off and reads it back', () => {
    const { store, personId } = freshPerson()
    store.setSleepUseBaseline(personId, false)
    expect(store.get(personId)!.sleepUseBaseline).toBe(false)
    store.setSleepUseBaseline(personId, true)
    expect(store.get(personId)!.sleepUseBaseline).toBe(true)
  })

  // A truthy string from a form posted as JSON is not a choice, and saving it as one would hand
  // the card a preference it reads as a boolean but the database holds as text.
  it('refuses a switch that is not a boolean', () => {
    const { store, personId } = freshPerson()
    expect(() => store.setSleepUseBaseline(personId, 'false' as unknown as boolean)).toThrow()
    expect(store.get(personId)!.sleepUseBaseline).toBe(true)
  })

  // The same assertion the target carries, for the same reason: the card computes at read time.
  it('leaves the derivation stamp alone, because nothing derived reads it', () => {
    const { store, personId } = freshPerson()
    const before = store.get(personId)!.builtDerivationVersion
    store.setSleepUseBaseline(personId, false)
    expect(store.get(personId)!.builtDerivationVersion).toBe(before)
  })
})
