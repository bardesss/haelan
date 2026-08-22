/**
 * Stamped on every derived row. Bump it when a derivation function changes what it would
 * produce from the same tier 1 data, which is what makes a rebuild necessary rather than
 * optional. M2e reads it at boot and queues every day when it has moved.
 *
 * 2: M2b writes merged rows and a source mix, so a day derived under 1 has neither.
 */
export const DERIVATION_VERSION = 2
