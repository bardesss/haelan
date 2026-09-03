import { describe, expect, it } from 'vitest'
import { EXERCISE_TYPES, SLEEP_STAGE_TYPES } from '../src/api/enums.ts'
import { ASLEEP_STAGES, AWAKE_STAGES } from '../src/derive/sleep.ts'

describe('the API enum catalogue', () => {
  // A count rather than a spot check, because the failure this guards against is a value quietly
  // going missing during transcription, which no spot check on the values you remembered would see.
  it('holds the 182 exercise types the discovery document declares', () => {
    expect(EXERCISE_TYPES).toHaveLength(182)
    expect(new Set(EXERCISE_TYPES).size, 'duplicate entries').toBe(182)
  })

  // The twelve one household produced in seven months. Their presence is what confirms this list
  // is the v4 vocabulary rather than Health Connect's, which names the same activities differently
  // and has no name at all for three of these.
  it('contains every type observed in real data', () => {
    for (const observed of ['BIKING', 'CARDIO_WORKOUT', 'HIKING', 'RUNNING', 'SPINNING', 'SPORT',
      'STROLLER_WALK', 'SWIMMING_POOL', 'TREADMILL', 'WALKING', 'WEIGHTLIFTING', 'WORKOUT']) {
      expect(EXERCISE_TYPES, observed).toContain(observed)
    }
  })

  // The derivation's own vocabulary and the schema's must be the same set. This is the assertion
  // that would have caught the discarded ASLEEP and RESTLESS segments four milestones earlier.
  it('agrees with the stage vocabulary the sleep derivation recognises', () => {
    expect([...SLEEP_STAGE_TYPES].sort()).toEqual([...ASLEEP_STAGES, ...AWAKE_STAGES].sort())
  })
})
