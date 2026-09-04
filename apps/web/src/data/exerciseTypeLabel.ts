import type { Translate } from '../format.js'

/**
 * The API declares 182 exercise types (packages/core/src/api/enums.ts); this app does not import
 * that module (apps/web must not reach into it, see that file's own comment), because a browser
 * label has no use for the drift catalogue and pulling it in would need a new safe subpath for
 * nothing. These twelve are what one household's seven months of sessions actually produced
 * (CARDIO_WORKOUT 37, WALKING 37, RUNNING 33, WORKOUT 19, SPINNING 18, BIKING 17, TREADMILL 17,
 * HIKING 4, WEIGHTLIFTING 4, STROLLER_WALK 3, SWIMMING_POOL 2, SPORT 1), so they are the ones
 * worth a real translation in both catalogues. eventKinds.ts's SEED_KINDS is the same shape for
 * event kinds.
 */
export const SEEDED_EXERCISE_TYPES: readonly string[] = [
  'CARDIO_WORKOUT', 'WALKING', 'RUNNING', 'WORKOUT', 'SPINNING', 'BIKING',
  'TREADMILL', 'HIKING', 'WEIGHTLIFTING', 'STROLLER_WALK', 'SWIMMING_POOL', 'SPORT',
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
 * directly, since translating all 182 values is 364 strings for activities nobody logs.
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
