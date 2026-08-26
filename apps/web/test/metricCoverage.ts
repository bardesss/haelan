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
 * 0.9 for everything else is a fully worn day, which is what the stubs already meant.
 */
export function coverageFor(metric: string): number | null {
  return metric.startsWith('sleep_') ? null : 0.9
}
