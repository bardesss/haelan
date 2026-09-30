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
 * The order a page lists the categories' records in: the sports with distances first, the busiest
 * of them leading, then the ones that keep only a longest session. sessionRecordsOf sends them in
 * this order and the Records page draws its cards in it.
 */
export const RECORD_CATEGORY_ORDER: readonly ExerciseCategory[] = ['run', 'ride', 'walk', 'swim', 'strength', 'cardio', 'other']

/**
 * The type a category is named after, whose label would only repeat the category's own: a Records
 * row under "Running" names its type only when it was something else (a trail run, a treadmill).
 * Null where no one type is the category's plain form, so every type there is named.
 */
export const PLAIN_TYPE: Readonly<Record<ExerciseCategory, string | null>> = {
  run: 'RUNNING',
  ride: 'BIKING',
  walk: 'WALKING',
  swim: 'SWIMMING',
  strength: null,
  cardio: null,
  other: null,
}

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

// The incline run and walk are the treadmill's own; the three cardio machines stand in one place.
// Records read this set for the climb alone (no most climb indoors); which types count toward
// distance and speed is countsForDistanceRecords' alone.
const INDOOR: ReadonlySet<string> = new Set([
  'TREADMILL', 'TREADMILL_WALK', 'INCLINE_RUN', 'INCLINE_WALK',
  'STATIONARY_BIKE', 'SPINNING', 'ASSAULT_BIKE',
  'ELLIPTICAL', 'ROWING_MACHINE', 'STAIRCLIMBER',
])

/**
 * The types done in one place: a treadmill's run or walk (the incline ones among them), a bike that
 * goes nowhere, and the cardio machines. A climb off the barometer there is drift, and an indoor
 * bike's speed is the machine's own reckoning rather than ground covered.
 */
export function isIndoor(type: string | null): boolean {
  return type !== null && INDOOR.has(type)
}

/** The rates a category can read, each the workout page's figure of that key. */
export type RateKey = 'pace' | 'speed' | 'swimPace'

/**
 * Each rate's unit and the precision it is sent at, the workout page's FIGURES for the three: a pace
 * in whole seconds a kilometre, a speed in metres a second to two decimals (a tenth of a km/h), a
 * swim's pace in whole seconds a 100 m.
 */
export const RATE_FIGURES: Readonly<Record<RateKey, { unit: string, precision: number }>> = {
  pace: { unit: 'seconds_per_km', precision: 0 },
  speed: { unit: 'meters_per_second', precision: 2 },
  swimPace: { unit: 'seconds_per_100m', precision: 0 },
}

/**
 * A session's own average rate as a list row prints it (sessions.ts's sessionRateOf): the figure's
 * key and unit, so a reader words it without knowing the session's category, and the value rounded
 * to that figure's precision.
 */
export interface SessionRate { key: RateKey, unit: string, value: number }

/** How the category reads a rate: 'pace' (min/km), 'speed' (km/h), 'swimPace' (min/100 m), or null for none. */
export function rateOf(category: ExerciseCategory): RateKey | null {
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
