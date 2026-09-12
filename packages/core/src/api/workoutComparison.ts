import { workoutSummary } from './workoutSummary.ts'

/**
 * One workout against recent ones of the same type, as a count rather than a rank.
 *
 * "Faster than 8 of your last 12 runs", never "8th of 12": a rank implies a completeness only M6's
 * archive-wide records can honestly claim, and claiming it here would either be wrong or would be
 * M6 built in the wrong milestone.
 *
 * Both numbers below are fixed here rather than taken from the page's control row, so the same
 * workout compares the same way however a reader arrived at it. A window that varied with the
 * range picker would make the sentence mean something different on each visit.
 *
 * In api/ rather than query/ because this has to be reachable from a browser: every module in
 * query/ imports the database, and apps/web can only import @haelan/core's published subpaths.
 */
export const COMPARISON_WINDOW_DAYS = 90
export const COMPARISON_LIMIT = 20
export const COMPARISON_MIN = 3

const DAY_MS = 86_400_000

export interface ComparableSession {
  id: string
  startMs: number
  excluded: boolean
  attrs: unknown
}

/** `better` of `of`: how many of the compared workouts this one beat on this measure. */
export interface ComparisonFacet { better: number, of: number }

export type ComparisonReason = 'no-type' | 'too-few'

export interface WorkoutComparison {
  exerciseType: string | null
  of: number
  /** Non-null means the card withholds itself and says which gate failed, the way M3e-2's insight
   *  cards already do: "no comparable workouts yet" and "this workout has no type" are different
   *  statements with different remedies. */
  reason: ComparisonReason | null
  pace: ComparisonFacet | null
  heartRate: ComparisonFacet | null
  distance: ComparisonFacet | null
}

const WITHHELD = { pace: null, heartRate: null, distance: null } as const

/**
 * A facet is dropped rather than reported thin: fewer than COMPARISON_MIN prior workouts recorded
 * this field, so there is no honest sentence to write about it. Only 97 of 192 real sessions carry
 * a distance and 77 a pace, so this is the ordinary case rather than a guard against a rarity.
 *
 * `lowerIsBetter` because two of the three measures improve downwards (a faster pace, a lower
 * average heart rate) and one upwards (a longer distance), and a single comparator with a flag is
 * what keeps the tie rule identical across all three: a tie is never counted as better.
 */
function facet(
  subjectValue: number | null,
  values: readonly (number | null)[],
  lowerIsBetter: boolean,
): ComparisonFacet | null {
  if (subjectValue === null) return null
  const present = values.filter((value): value is number => value !== null)
  if (present.length < COMPARISON_MIN) return null
  const better = present.filter((value) =>
    lowerIsBetter ? value > subjectValue : value < subjectValue).length
  return { better, of: present.length }
}

export function compareWorkout(
  subject: ComparableSession,
  candidates: readonly ComparableSession[],
): WorkoutComparison {
  const subjectSummary = workoutSummary(subject.attrs)
  const exerciseType = subjectSummary.exerciseType
  if (exerciseType === null) return { exerciseType, of: 0, reason: 'no-type', ...WITHHELD }

  const windowStart = subject.startMs - COMPARISON_WINDOW_DAYS * DAY_MS
  const compared = candidates
    .filter((candidate) => candidate.id !== subject.id)
    // Strictly before the subject: an earlier run on the same day counts, and a later one is not
    // something this workout can already have been compared against.
    .filter((candidate) => candidate.startMs < subject.startMs && candidate.startMs >= windowStart)
    // A person who excluded a session has already said it should not count.
    .filter((candidate) => !candidate.excluded)
    .map((candidate) => ({ candidate, summary: workoutSummary(candidate.attrs) }))
    .filter((entry) => entry.summary.exerciseType === exerciseType)
    .sort((a, b) => b.candidate.startMs - a.candidate.startMs)
    .slice(0, COMPARISON_LIMIT)

  if (compared.length < COMPARISON_MIN) {
    return { exerciseType, of: compared.length, reason: 'too-few', ...WITHHELD }
  }

  return {
    exerciseType,
    of: compared.length,
    reason: null,
    pace: facet(subjectSummary.paceSecondsPerKm, compared.map((e) => e.summary.paceSecondsPerKm), true),
    heartRate: facet(subjectSummary.averageHeartRateBpm, compared.map((e) => e.summary.averageHeartRateBpm), true),
    distance: facet(subjectSummary.distanceMeters, compared.map((e) => e.summary.distanceMeters), false),
  }
}
