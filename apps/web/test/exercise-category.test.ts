import { describe, it, expect } from 'vitest'
import { exerciseCategory, EXERCISE_CATEGORIES } from '../src/data/exerciseCategory.js'
import { SEEDED_EXERCISE_TYPES } from '../src/data/exerciseTypeLabel.js'

/**
 * A glyph per category, never per type.
 *
 * The catalogue declares 182 exercise types and a real archive holds about a dozen, so an icon per
 * type is not a drawing job, it is 170 drawings nobody will ever see. Categories are the level a
 * reader actually scans at: they are looking for the runs, not for the difference between RUNNING
 * and TREADMILL.
 *
 * The fallback is the load-bearing part. `other` is a real glyph rather than nothing, so every row
 * carries a mark - which is exactly what the Records device column got wrong, where an absent cell
 * left some rows with art and some without and the list read as broken.
 */
describe('which category an exercise type belongs to', () => {
  it('has a glyph for every category it can answer', () => {
    // The set the icon map has to cover. A category with no glyph would render an empty span,
    // which is the failure this whole mapping exists to avoid.
    expect(EXERCISE_CATEGORIES).toContain('other')
    expect(new Set(EXERCISE_CATEGORIES).size).toBe(EXERCISE_CATEGORIES.length)
  })

  it('answers a category for every type the app has ever seen', () => {
    // SEEDED_EXERCISE_TYPES is the list the translations cover, and on the archive this was
    // measured against it is also the complete set of types that occur. Every one has to land
    // somewhere deliberate rather than falling through.
    for (const type of SEEDED_EXERCISE_TYPES) {
      expect(EXERCISE_CATEGORIES, type).toContain(exerciseCategory(type))
    }
  })

  it('groups the types a reader would group', () => {
    expect(exerciseCategory('RUNNING')).toBe('run')
    expect(exerciseCategory('TREADMILL')).toBe('run')
    expect(exerciseCategory('WALKING')).toBe('walk')
    expect(exerciseCategory('HIKING')).toBe('walk')
    expect(exerciseCategory('STROLLER_WALK')).toBe('walk')
    expect(exerciseCategory('BIKING')).toBe('ride')
    expect(exerciseCategory('SPINNING')).toBe('ride')
    expect(exerciseCategory('SWIMMING_POOL')).toBe('swim')
    expect(exerciseCategory('WEIGHTLIFTING')).toBe('strength')
  })

  // The most common type in the measured archive, and the one that would look worst falling
  // through to a generic mark.
  it('gives the two unspecific workout types a heart rather than the fallback', () => {
    expect(exerciseCategory('CARDIO_WORKOUT')).toBe('cardio')
    expect(exerciseCategory('WORKOUT')).toBe('cardio')
  })

  it('falls back rather than guessing, for a type nobody mapped', () => {
    expect(exerciseCategory('CROSS_COUNTRY_SKI')).toBe('other')
    expect(exerciseCategory('HOUSEHOLD_CHORES')).toBe('other')
  })

  // A session whose device recorded no type at all. It still gets a row, so it still gets a mark.
  it('falls back for a session with no type', () => {
    expect(exerciseCategory(null)).toBe('other')
  })
})
