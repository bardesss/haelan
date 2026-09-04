import { describe, expect, it } from 'vitest'
import { exerciseTypeLabel, SEEDED_EXERCISE_TYPES } from '../src/data/exerciseTypeLabel.js'

// A stand in for i18next's t: returns the key itself when the catalogue has no entry, which is what
// react-i18next does, so the fallback path is exercised rather than mocked away.
const t = (catalogue: Record<string, string>) => (key: string) => catalogue[key] ?? key

describe('exerciseTypeLabel', () => {
  it('uses the catalogue string for a seeded type', () => {
    const label = exerciseTypeLabel(t({ 'activity.exerciseTypes.RUNNING': 'Hardlopen' }), 'RUNNING')
    expect(label).toBe('Hardlopen')
  })

  // The thirteen a real household produced in seven months, counted off the live database rather
  // than remembered. Every one must be seeded, because these are the labels almost every reader
  // will actually see, and a type left out prints its humanised English fallback on a Dutch page.
  // HOUSEHOLD_CHORES was the one missed: a single session, exactly what SPORT has.
  it('seeds every type the reporting household produced', () => {
    for (const type of ['WALKING', 'CARDIO_WORKOUT', 'RUNNING', 'WORKOUT', 'SPINNING', 'BIKING',
      'TREADMILL', 'HIKING', 'WEIGHTLIFTING', 'STROLLER_WALK', 'SWIMMING_POOL', 'SPORT',
      'HOUSEHOLD_CHORES']) {
      expect(SEEDED_EXERCISE_TYPES, type).toContain(type)
    }
    expect(SEEDED_EXERCISE_TYPES, 'the list and the census above are the same thirteen').toHaveLength(13)
  })

  // The API declares 182 types and this app seeds thirteen. The other 169 must still be readable:
  // showing SNOWBOARDING is the same failure as the source picker showing a 32 character hex id.
  it('humanises an unseeded type rather than showing the raw constant', () => {
    const fallback = t({})
    expect(exerciseTypeLabel(fallback, 'SNOWBOARDING')).toBe('Snowboarding')
    expect(exerciseTypeLabel(fallback, 'CROSS_COUNTRY_SKI')).toBe('Cross country ski')
    expect(exerciseTypeLabel(fallback, 'YOGA_BIKRAM')).toBe('Yoga bikram')
  })

  // A humanised label must never be mistaken for a translation that already exists, so a seeded
  // type whose catalogue entry is missing still falls back rather than rendering the raw key.
  it('falls back when a seeded type has no catalogue entry', () => {
    expect(exerciseTypeLabel(t({}), 'RUNNING')).toBe('Running')
  })

  it('answers a stated unknown for a session with no type at all', () => {
    const label = exerciseTypeLabel(t({ 'activity.exerciseTypes.unknown': 'Onbekend' }), null)
    expect(label).toBe('Onbekend')
  })
})
