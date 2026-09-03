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
 *    every total by about 7 minutes a night, and the stage vocabulary was missing ASLEEP and
 *    RESTLESS, so classic nights derived no measurement at all. A classic night derived under 4
 *    also writes sleep_deep_minutes, sleep_light_minutes and sleep_rem_minutes as zero, claiming a
 *    staging measurement that never happened; under 5 it omits the three instead.
 */
export const DERIVATION_VERSION = 5
