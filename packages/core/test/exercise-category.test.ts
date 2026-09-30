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

  // The sports and activities that are deliberately `other`. A value the API adds and nobody
  // classifies falls through to `other` too, so this pins how many values are placed: adding an
  // enum value without deciding on its category changes neither number and is caught by the
  // per-type table below only for the placed ones, so keep both in step with enums.ts.
  it('places a pinned number of enum values in a category other than other', () => {
    const placed = EXERCISE_TYPES.filter((t) => exerciseCategory(t) !== 'other')
    expect(placed.length).toBe(EXERCISE_TYPES.length - 127)
  })

  it.each([
    ['RUNNING', 'run'], ['TREADMILL', 'run'], ['TRAIL_RUN', 'run'], ['INCLINE_RUN', 'run'], ['TRACK_AND_FIELD', 'run'],
    ['WALKING', 'walk'], ['HIKING', 'walk'], ['STROLLER_WALK', 'walk'], ['TREADMILL_WALK', 'walk'],
    ['INCLINE_WALK', 'walk'], ['NORDIC_WALKING', 'walk'], ['POWER_WALKING', 'walk'],
    ['WALK_WITH_WEIGHTS', 'walk'], ['RUCKING', 'walk'], ['BACKPACKING', 'walk'],
    ['BIKING', 'ride'], ['OUTDOOR_BIKE', 'ride'], ['MOUNTAIN_BIKE', 'ride'], ['ELECTRIC_BIKE', 'ride'],
    ['STATIONARY_BIKE', 'ride'], ['SPINNING', 'ride'], ['ASSAULT_BIKE', 'ride'], ['HAND_CYCLING', 'ride'],
    ['SWIMMING', 'swim'], ['SWIMMING_POOL', 'swim'], ['SWIMMING_OPEN_WATER', 'swim'],
    ['WEIGHTLIFTING', 'strength'], ['STRENGTH_TRAINING', 'strength'], ['POWERLIFTING', 'strength'],
    ['CARDIO_WORKOUT', 'cardio'], ['WORKOUT', 'cardio'], ['ELLIPTICAL', 'cardio'], ['ROWING', 'cardio'],
    ['HIIT', 'cardio'], ['HOUSEHOLD_CHORES', 'other'], ['CROSS_COUNTRY_SKI', 'other'],
  ] as const)('reads %s as %s', (type, category) => {
    expect(exerciseCategory(type)).toBe(category)
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
