import type { Translate } from '../format.js'

/**
 * The API declares 182 exercise types (packages/core/src/api/enums.ts); this app does not import
 * that module. The boundary is @haelan/core's `exports` map, which publishes four browser-safe
 * subpaths and puts enums.ts on none of them, so reaching it would mean a fifth entry plus the
 * no-imports guard each of the four carries (metrics-subpath.test.ts explains what that guard is
 * protecting), for a catalogue a browser label has no use for. enums.ts's own comment says only
 * why the values are there, which is drift detection against the live discovery document, and
 * states no boundary of its own.
 *
 * These thirteen are what one household's seven months of 192 sessions actually produced (WALKING
 * 37, CARDIO_WORKOUT 36, RUNNING 33, WORKOUT 19, SPINNING 18, BIKING 17, TREADMILL 17, HIKING 4,
 * WEIGHTLIFTING 4, STROLLER_WALK 3, SWIMMING_POOL 2, SPORT 1, HOUSEHOLD_CHORES 1), so they are
 * the ones worth a real translation in both catalogues. HOUSEHOLD_CHORES is seeded on the same
 * single session SPORT is: the rule is what the data holds, not how much of it there is, and a
 * type left out falls back to humanise, which produces English ("Household chores") on a page
 * that is otherwise Dutch. eventKinds.ts's SEED_KINDS is the same shape for event kinds.
 */
export const SEEDED_EXERCISE_TYPES: readonly string[] = [
  'WALKING', 'CARDIO_WORKOUT', 'RUNNING', 'WORKOUT', 'SPINNING', 'BIKING',
  'TREADMILL', 'HIKING', 'WEIGHTLIFTING', 'STROLLER_WALK', 'SWIMMING_POOL', 'SPORT',
  'HOUSEHOLD_CHORES',
]

/**
 * Turns a raw constant such as CROSS_COUNTRY_SKI into "Cross country ski": lowercase, underscores
 * to spaces, first letter capitalised. This is not a translation and must not be mistaken for
 * one, but it beats a screaming snake case constant on screen, which is the source picker's own
 * hex id problem.
 */
function humanise(type: string): string {
  const lower = type.toLowerCase().replace(/_/g, ' ')
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * The label a reader sees for a session's exercise type. A seeded type gets the catalogue string
 * (or, if that entry is missing, its own humanised fallback rather than the raw i18next key,
 * since a missing translation must never be mistaken for one); anything else is humanised
 * directly, since translating all 169 unseeded values is 338 strings for activities nobody logs.
 */
export function exerciseTypeLabel(t: Translate, type: string | null): string {
  if (type === null) return t('activity.exerciseTypes.unknown')
  if (SEEDED_EXERCISE_TYPES.includes(type)) {
    const key = `activity.exerciseTypes.${type}`
    const translated = t(key)
    return translated === key ? humanise(type) : translated
  }
  return humanise(type)
}
