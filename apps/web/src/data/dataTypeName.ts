import type { Translate } from '../format.js'

/**
 * The label a reader sees for a catalogue id, in DataTypePicker and BackfillStep alike -- the two
 * screens that used to print `daily-resting-heart-rate` next to `heart-rate-variability` next to
 * `daily-heart-rate-variability` and left a reader to guess which was which. `dataTypes.<id>`
 * carries the actual distinction (a continuous stream against a once-a-day summary reading) that a
 * title-cased id cannot.
 *
 * No `defaultValue` option on the `t()` call itself: react-i18next's own default there is the key
 * string, not the id, so a data type the catalogue gains before anyone names it would render as
 * `dataTypes.some-new-id` rather than `some-new-id`, exactly the raw-key regression this file exists
 * to keep off screen. Comparing the result against the key, the same test exerciseTypeLabel.ts
 * already uses for its own seeded/unseeded split, is what turns that into the honest fallback.
 */
export function dataTypeName(t: Translate, id: string): string {
  const key = `dataTypes.${id}`
  const translated = t(key)
  return translated === key ? id : translated
}
