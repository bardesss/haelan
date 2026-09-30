/**
 * The one map from an exercise type to the category it is read as, shared by core and the web.
 *
 * A category rather than a type, because the catalogue declares 180-odd exercise types and a real
 * archive holds about a dozen: an icon per type would be drawings nobody ever sees, and a reader
 * scans at the level of "the runs in a month", not the difference between RUNNING and TREADMILL.
 *
 * `other` is a real category with a real glyph, not an absence. Every row carries a mark.
 *
 * Browser-safe: imports nothing, so apps/web can read it through `@haelan/core/exercise-category`
 * without pulling the database into the bundle (exercise-category-subpath.test.ts holds that).
 */
export const EXERCISE_CATEGORIES = ['run', 'walk', 'ride', 'swim', 'strength', 'cardio', 'other'] as const

export type ExerciseCategory = (typeof EXERCISE_CATEGORIES)[number]

/**
 * Written out rather than inferred from the name: `SPORT` contains no clue, `STROLLER_WALK` is a
 * walk and `TREADMILL` is a run. A type absent here is `other`, and exercise-category.test.ts goes
 * red for any enum value that is neither listed here nor deliberately `other`.
 */
const BY_TYPE: Readonly<Record<string, ExerciseCategory>> = {
  RUNNING: 'run',
  TREADMILL: 'run',
  TRAIL_RUN: 'run',
  INCLINE_RUN: 'run',
  TRACK_AND_FIELD: 'run',

  WALKING: 'walk',
  HIKING: 'walk',
  STROLLER_WALK: 'walk',
  TREADMILL_WALK: 'walk',
  INCLINE_WALK: 'walk',
  NORDIC_WALKING: 'walk',
  POWER_WALKING: 'walk',
  WALK_WITH_WEIGHTS: 'walk',
  RUCKING: 'walk',
  BACKPACKING: 'walk',

  BIKING: 'ride',
  OUTDOOR_BIKE: 'ride',
  MOUNTAIN_BIKE: 'ride',
  ELECTRIC_BIKE: 'ride',
  STATIONARY_BIKE: 'ride',
  SPINNING: 'ride',
  ASSAULT_BIKE: 'ride',
  HAND_CYCLING: 'ride',

  SWIMMING: 'swim',
  SWIMMING_POOL: 'swim',
  SWIMMING_OPEN_WATER: 'swim',

  WEIGHTLIFTING: 'strength',
  STRENGTH_TRAINING: 'strength',
  FUNCTIONAL_STRENGTH_TRAINING: 'strength',
  POWERLIFTING: 'strength',
  FREE_WEIGHTS: 'strength',
  WEIGHT_MACHINES: 'strength',
  WEIGHTS: 'strength',
  BODY_WEIGHT: 'strength',
  CALISTHENICS: 'strength',
  RESISTANCE_BANDS: 'strength',
  CORE_TRAINING: 'strength',
  TRX: 'strength',

  // The unspecific ones, and between them the commonest thing in a real archive. They are not
  // `other`: a device that says only "a workout" has still told us it was cardio.
  CARDIO_WORKOUT: 'cardio',
  WORKOUT: 'cardio',
  AEROBIC_WORKOUT: 'cardio',
  CARDIO_SCULPT: 'cardio',
  HIIT: 'cardio',
  INTERVAL_WORKOUT: 'cardio',
  TABATA_WORKOUT: 'cardio',
  CIRCUIT_TRAINING: 'cardio',
  BOOTCAMP: 'cardio',
  CROSS_TRAINING: 'cardio',
  CROSSFIT: 'cardio',
  ELLIPTICAL: 'cardio',
  ROWING: 'cardio',
  ROWING_MACHINE: 'cardio',
  STAIRCLIMBER: 'cardio',
  STEP_TRAINING: 'cardio',
  JUMPING_ROPE: 'cardio',
}

/** The category to draw for a session's type, or `other` for one nobody mapped and for none. */
export function exerciseCategory(type: string | null): ExerciseCategory {
  if (type === null) return 'other'
  return BY_TYPE[type] ?? 'other'
}

const NOT_FOR_RECORDS: ReadonlySet<string> = new Set([
  'TREADMILL', 'STATIONARY_BIKE', 'SPINNING', 'ASSAULT_BIKE', 'ELECTRIC_BIKE', 'TREADMILL_WALK',
])

/** Indoor or assisted variants that do not count toward distance or speed records. */
export function countsForDistanceRecords(type: string | null): boolean {
  return type === null || !NOT_FOR_RECORDS.has(type)
}

/** How the category reads a rate: 'pace' (min/km), 'speed' (km/h), 'swimPace' (min/100 m), or null for none. */
export function rateOf(category: ExerciseCategory): 'pace' | 'speed' | 'swimPace' | null {
  switch (category) {
    case 'run':
    case 'walk':
      return 'pace'
    case 'ride':
      return 'speed'
    case 'swim':
      return 'swimPace'
    default:
      return null
  }
}
