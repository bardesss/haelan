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

  // Seven values: the six real stages plus the protobuf unset sentinel, SLEEP_STAGE_TYPE_UNSPECIFIED,
  // which the schema declares but which the API never emits as a recorded stage.
  it('holds the 7 sleep stage types the discovery document declares', () => {
    expect(SLEEP_STAGE_TYPES).toHaveLength(7)
  })

  // The derivation's own vocabulary and the schema's must be the same set of actual stages. The
  // sentinel is excluded here on purpose: SLEEP_STAGE_TYPE_UNSPECIFIED means the field was not set,
  // not that the segment was in some third state, so the derivation correctly never recognises it
  // as a stage, while the catalogue correctly records that the schema declares it. Comparing the
  // full seven against the derivation's six would fail on that basis alone, which would not be
  // testing what this test exists to test. This is still the assertion that would have caught the
  // discarded ASLEEP and RESTLESS segments four milestones earlier: it is an equality, not a subset
  // check, so a missing or extra non-sentinel value on either side still fails it.
  it('agrees with the stage vocabulary the sleep derivation recognises', () => {
    const stagesOnly = SLEEP_STAGE_TYPES.filter((s) => s !== 'SLEEP_STAGE_TYPE_UNSPECIFIED')
    expect([...stagesOnly].sort()).toEqual([...ASLEEP_STAGES, ...AWAKE_STAGES].sort())
  })
})
