import type { SeriesPoint } from '../src/data/useSeries.js'

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
 *
 * weight and body_fat belong here too, for a different reason than the four metrics above them:
 * those come from a wearable's own continuous sampling condensed into one daily figure, while a
 * weight or body fat reading is entered by hand, touching at most an hour or two of the scale's
 * own day. Either way, coverageOf (derive/coverage.ts) counts distinct hours under the day's
 * samples, so none of the six can reach anywhere near 0.9 in a real response.
 */
const ONCE_DAILY = new Set([
  'resting_heart_rate', 'daily_hrv', 'respiratory_rate', 'daily_spo2', 'weight', 'body_fat',
])

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

/**
 * One /series row in the shape the server really sends, for a stub to hand back.
 *
 * Typed as SeriesPoint rather than left to an object literal inside a JSON.stringify call, which
 * is what every page stub used to be: those literals reach the wire as `unknown`, so nothing
 * checked them and several drifted, omitting `source`, `updatedAtMs` or both. useSeries.ts states
 * the rule the type exists for ("source and updatedAtMs are on every point the server actually
 * answers ... a type that hid those fields would be lying about a response nothing here
 * composed"), and one unrealistic field on a stubbed row is what let a null coverage render as
 * "device not worn" over a full month through thirteen reviews.
 *
 * updatedAtMs defaults to a real stamp rather than null. Null is a legitimate value on the wire
 * (personQuery.ts: a row derived before M3b added the column, or one no rebuild has touched
 * since), so it stays overridable, but the ordinary row carries a number and a default that does
 * not is the same kind of unrepresentative stub this helper exists to stop.
 */
export function seriesPoint(
  metric: string, localDate: string, value: number, overrides: Partial<SeriesPoint> = {},
): SeriesPoint {
  return {
    localDate,
    value,
    coverage: coverageFor(metric),
    source: 'merged',
    sourceMix: null,
    updatedAtMs: 1_755_000_000_000,
    ...overrides,
  }
}
