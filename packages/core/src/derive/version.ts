/**
 * Stamped on every derived row. Bump it when a derivation function changes what it would
 * produce from the same tier 1 data, which is what makes a rebuild necessary rather than
 * optional. `rebuild/versions.ts` compares it against each person's stamp at boot and rebuilds
 * whoever is behind: directly, inside the person's own transaction, rather than by queueing days
 * for the drain to pick up, because a rebuild that marked days dirty and returned would report
 * success while the work was still outstanding.
 *
 * 2: M2b writes merged rows and a source mix, so a day derived under 1 has neither.
 * 3: M2c writes the sleep_* family, so a day derived under 2 has no sleep rows at all.
 * 4: M3b adds spo2, hrv and heart rate counts, the workout rollups, and a written-at stamp, so a
 *    day derived under 3 has no count rows, no workout rows, and a null stamp.
 * 5: M3f-E corrects two sleep derivation defects, so every sleep_*_minutes value derived under 4
 *    is wrong. Durations were summed as per segment roundings against a 30 second grid, inflating
 *    every total by about 7 minutes a night. And the vocabulary held four of the schema's six
 *    stage values, missing ASLEEP and RESTLESS, so a night recorded in the provider's classic
 *    non-staged model derived no stage, asleep, awake or efficiency figure at all. Under 5 such a
 *    night derives all of those except the three staged minutes, which it omits rather than
 *    writing as zero, because a night nobody staged has no deep, light or REM measurement.
 * 6: the catalogue caught up with the API, adding a third derived table - `observations`, for the
 *    categorical types that have no numeric value - alongside new metrics across samples. A person
 *    derived under 5 has an empty observations table and none of those metrics, and unlike the
 *    bumps above this one is less about a function computing something different and more about
 *    there being new rows to compute at all.
 * 7: M5d-A rekeys `samples` onto integers, and migration 0016 drops the old table rather than
 *    copying its 1.6 million rows, so every day derived under 6 was derived from rows that are no
 *    longer on disk. Nothing about what deriveDay computes changed - the same readings produce the
 *    same numbers - and the bump is here anyway, because tier 3 standing over an empty tier 2 is
 *    the exact state a stamp exists to prevent, and a mapping bump alone would say the layer below
 *    moved while leaving these rows claiming to have been derived from it.
 * 8: the cardio load family arrives - `cardio_load_edwards`, derived from the day's zone minutes
 *    rather than from any data type, because Google Health shows a cardio load number and the v4
 *    API exposes none. A day derived under 7 has no such row. Nothing else about what deriveDay
 *    computes changed.
 * 9: the activity band overlap arrives - active_minutes_{light,moderate,vigorous}_peak, the count
 *    of clock minutes carrying both an activity level and a peak heart rate zone. A day derived
 *    under 8 has no such rows, so the four band chart would draw its peak band empty and its other
 *    three bands as unsplit totals: wrong rather than absent, which is what makes this bump
 *    necessary rather than optional. probe/findings/activity-minute-overlap.md measured why the
 *    intersection has to be stored at all.
 */
export const DERIVATION_VERSION = 9
