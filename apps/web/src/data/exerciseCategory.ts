/**
 * The categories a session row draws a glyph for.
 *
 * A category rather than a type, because the catalogue declares 182 exercise types and a real
 * archive holds about a dozen: an icon per type would be 170 drawings nobody ever sees. A category
 * is also the level a reader scans at - they are looking for the runs in a month, not for the
 * difference between RUNNING and TREADMILL.
 *
 * `other` is a real category with a real glyph, not an absence. Every row carries a mark, which is
 * the thing the Records device column got wrong: an omitted cell left some rows with art and some
 * without, and the list read as broken rather than as varied.
 */
export const EXERCISE_CATEGORIES = ['run', 'walk', 'ride', 'swim', 'strength', 'cardio', 'other'] as const

export type ExerciseCategory = (typeof EXERCISE_CATEGORIES)[number]

/**
 * Written out rather than inferred from the name. `SPORT` contains no clue, `STROLLER_WALK` is a
 * walk and `TREADMILL` is a run, and a substring rule that got those right would still put
 * `SWIMMING_POOL` and `POOL` wherever the first match happened to land.
 *
 * Types beyond the ones an archive has actually produced are here only where the grouping is
 * obvious and the name unambiguous, which is what keeps this a mapping rather than a guess: a type
 * nobody has seen falls through to `other` and draws the fallback mark, and that is a correct
 * answer rather than a missing one.
 */
const BY_TYPE: Record<string, ExerciseCategory> = {
  RUNNING: 'run',
  TREADMILL: 'run',
  RUNNING_TREADMILL: 'run',

  WALKING: 'walk',
  HIKING: 'walk',
  STROLLER_WALK: 'walk',

  BIKING: 'ride',
  SPINNING: 'ride',
  BIKING_STATIONARY: 'ride',

  SWIMMING_POOL: 'swim',
  SWIMMING_OPEN_WATER: 'swim',

  WEIGHTLIFTING: 'strength',
  STRENGTH_TRAINING: 'strength',

  // The two unspecific ones, and between them the commonest thing in a real archive. They are not
  // `other`: a device that says only "a workout" has still told us it was cardio, and the heart is
  // a truer mark for it than the fallback bars.
  CARDIO_WORKOUT: 'cardio',
  WORKOUT: 'cardio',
  HIGH_INTENSITY_INTERVAL_TRAINING: 'cardio',
}

/** The category to draw for a session's type, or `other` for one nobody mapped and for none. */
export function exerciseCategory(type: string | null): ExerciseCategory {
  if (type === null) return 'other'
  return BY_TYPE[type] ?? 'other'
}
