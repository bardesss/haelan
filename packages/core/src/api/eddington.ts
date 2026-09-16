/**
 * E days of at least E units: one integer, ungameable, and harder to raise the higher it climbs.
 *
 * Generalised off the cycling number, which counts days of at least E miles. Here `unit` is a
 * thousand steps, so E = 13 means thirteen days of at least thirteen thousand steps.
 *
 * **It takes no eligibility filter, and that is a measurement rather than an omission.** Against
 * the household archive on 2026-09-15 it answered 13 raw, 13 with corrections applied, and 13
 * with coverage gates discarding up to 80 of 235 days. The statistic is decided by the Eth best
 * day, and every gate anybody proposed removes days from the bottom of the distribution, where E
 * is not. A caller wanting a filtered number can filter its own input, but nothing in this
 * project has yet found a filter that changes the answer.
 *
 * Pure, in `api/` beside `trainingLoad.ts`, so it can be tested without a database and read
 * without one.
 */
export function eddingtonOf(values: readonly number[], unit: number): number {
  // Descending, so the Eth best day is at index E - 1 and the walk below can stop at the first
  // day that fails its own test.
  const sorted = values.map((value) => value / unit).sort((a, b) => b - a)
  let e = 0
  while (e < sorted.length && sorted[e]! >= e + 1) e += 1
  return e
}
