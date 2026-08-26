/**
 * The coverage a stubbed /series row would really carry for a metric.
 *
 * Every stub in this suite used to hand every metric `coverage: 0.9`, including the sleep
 * metrics, which the server can never send that way: packages/core/src/derive/sleep.ts writes
 * `coverage: null` for every sleep row on purpose ("a night has no samples underneath it, so the
 * fraction of the day's hours carrying one is not a question this row can answer"), and
 * sleepMerge.ts routes merged rows through the same function. One unrealistic field is what let
 * a null coverage render as "device not worn" over a fully populated month through thirteen task
 * reviews, so the shape lives here once rather than being remembered per stub.
 *
 * A once a day metric observes one hour out of twenty four, so a real row reads 1/24 and never
 * 0.9. Stating the true shape here is not tidiness: a stub that cannot express a real response
 * is a stub that hides a real defect, which is how a card claiming "device not worn" over a full
 * month of sleep survived thirteen reviews.
 */
const ONCE_DAILY = new Set(['resting_heart_rate', 'daily_hrv', 'respiratory_rate'])

export function coverageFor(metric: string): number | null {
  if (metric.startsWith('sleep_')) return null
  if (ONCE_DAILY.has(metric)) return 1 / 24
  return 0.9
}

/**
 * Metrics a provider (rather than a wearable's own sampling) reports for the whole day at once,
 * so a stub can mark their rows `source: 'provider'` the way a real one would.
 */
export const PROVIDER_METRICS = new Set(['floors', 'total_calories'])
