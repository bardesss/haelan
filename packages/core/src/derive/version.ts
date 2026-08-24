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
 */
export const DERIVATION_VERSION = 3
