import type { RecoveryInput, RecoveryInputKey } from '../../data/periodTypes.js'

export interface ContributionRow {
  key: RecoveryInputKey
  points: number
}

/**
 * The inputs, largest mover first, with points rounded to whole numbers.
 *
 * Largest-first rather than a fixed order because the question this list answers is "what moved
 * it", and an input that moved it by a point is not the answer however important it usually is.
 *
 * These do NOT sum to the score's distance from 50, except on a day every input pushed the same
 * way: an input's `points` (packages/core/src/api/recoveryIndex.ts) is scaled by the total
 * absolute movement across inputs, not by the signed composite, so two inputs pulling in opposite
 * directions genuinely cancel rather than adding up to the score. This list never claims a total.
 */
export function contributionRows(inputs: readonly RecoveryInput[]): ContributionRow[] {
  return [...inputs]
    .map((input) => ({ key: input.key, points: Math.round(input.points) }))
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
}
