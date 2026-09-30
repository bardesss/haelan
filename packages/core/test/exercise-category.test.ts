import { describe, expect, it } from 'vitest'
import { EXERCISE_TYPES } from '../src/api/enums.ts'
import {
  EXERCISE_CATEGORIES, countsForDistanceRecords, exerciseCategory, rateOf,
} from '../src/api/exerciseCategory.ts'

describe('the exercise category map', () => {
  it('answers a known category for every enum value', () => {
    expect(EXERCISE_TYPES.length).toBeGreaterThan(150)
    for (const type of EXERCISE_TYPES) expect(EXERCISE_CATEGORIES, type).toContain(exerciseCategory(type))
  })

  // Every member of every non-other category, named. Moving a type to the wrong category, or
  // adding or dropping one, fails here with the type's name; every other enum value must be other.
  const MEMBERS: Record<string, readonly string[]> = {
    run: ['INCLINE_RUN', 'RUNNING', 'TRACK_AND_FIELD', 'TRAIL_RUN', 'TREADMILL'],
    walk: [
      'BACKPACKING', 'HIKING', 'INCLINE_WALK', 'NORDIC_WALKING', 'POWER_WALKING', 'RUCKING',
      'STROLLER_WALK', 'TREADMILL_WALK', 'WALKING', 'WALK_WITH_WEIGHTS',
    ],
    ride: [
      'ASSAULT_BIKE', 'BIKING', 'ELECTRIC_BIKE', 'HAND_CYCLING', 'MOUNTAIN_BIKE', 'OUTDOOR_BIKE',
      'SPINNING', 'STATIONARY_BIKE',
    ],
    swim: ['SWIMMING', 'SWIMMING_OPEN_WATER', 'SWIMMING_POOL'],
    strength: [
      'BODY_WEIGHT', 'CALISTHENICS', 'CORE_TRAINING', 'FREE_WEIGHTS', 'FUNCTIONAL_STRENGTH_TRAINING',
      'POWERLIFTING', 'RESISTANCE_BANDS', 'STRENGTH_TRAINING', 'TRX', 'WEIGHTLIFTING',
      'WEIGHT_MACHINES', 'WEIGHTS',
    ],
    cardio: [
      'AEROBIC_WORKOUT', 'BOOTCAMP', 'CARDIO_SCULPT', 'CARDIO_WORKOUT', 'CIRCUIT_TRAINING',
      'CROSSFIT', 'CROSS_TRAINING', 'ELLIPTICAL', 'HIIT', 'INTERVAL_WORKOUT', 'JUMPING_ROPE',
      'ROWING', 'ROWING_MACHINE', 'STAIRCLIMBER', 'STEP_TRAINING', 'TABATA_WORKOUT', 'WORKOUT',
    ],
  }

  it.each(Object.entries(MEMBERS))('%s holds exactly its listed types', (category, members) => {
    const actual = EXERCISE_TYPES.filter((t) => exerciseCategory(t) === category).sort()
    expect(actual).toEqual([...members].sort())
  })

  it('maps every enum value outside those lists to other', () => {
    const listed = new Set(Object.values(MEMBERS).flat())
    for (const t of EXERCISE_TYPES) {
      if (!listed.has(t)) expect(exerciseCategory(t), t).toBe('other')
    }
  })

  it('lists only types the enum declares', () => {
    for (const t of Object.values(MEMBERS).flat()) expect(EXERCISE_TYPES, t).toContain(t)
  })

  it('does not know the two names the old web map invented', () => {
    expect(exerciseCategory('RUNNING_TREADMILL')).toBe('other')
    expect(exerciseCategory('BIKING_STATIONARY')).toBe('other')
  })

  it('falls back for a session with no type', () => {
    expect(exerciseCategory(null)).toBe('other')
  })
})

describe('countsForDistanceRecords', () => {
  it.each(['TREADMILL', 'STATIONARY_BIKE', 'SPINNING', 'ASSAULT_BIKE', 'ELECTRIC_BIKE', 'TREADMILL_WALK'])(
    'excludes %s', (type) => expect(countsForDistanceRecords(type)).toBe(false),
  )

  it.each(['RUNNING', 'TRAIL_RUN', 'INCLINE_RUN', 'WALKING', 'HIKING', 'BIKING', 'MOUNTAIN_BIKE', 'SWIMMING_POOL', 'WEIGHTLIFTING'])(
    'counts %s', (type) => expect(countsForDistanceRecords(type)).toBe(true),
  )

  it('counts a session with no type', () => {
    expect(countsForDistanceRecords(null)).toBe(true)
  })
})

describe('rateOf', () => {
  it('reads each category as its own kind of rate', () => {
    expect(rateOf('run')).toBe('pace')
    expect(rateOf('walk')).toBe('pace')
    expect(rateOf('ride')).toBe('speed')
    expect(rateOf('swim')).toBe('swimPace')
    expect(rateOf('strength')).toBeNull()
    expect(rateOf('cardio')).toBeNull()
    expect(rateOf('other')).toBeNull()
  })
})
