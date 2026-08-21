import type { SampleAgg } from '../db/schema/derived.ts'

// The filterable member differs per type across five shapes and none of it is documented.
// Every value here was measured against the live API in M0; see probe/findings/field-map.md.
export const FILTER_MEMBERS = [
  'interval.start_time',
  'sample_time.physical_time',
  'date',
  'interval.end_time',
  'interval.civil_start_time',
] as const
export type FilterMember = (typeof FILTER_MEMBERS)[number]

export type MappingTarget = 'samples' | 'sessions'

export interface DataType {
  /** Kebab case, as it appears in the URL path. */
  id: string
  /** Snake case, as the filter parser demands. Rejects the camel form outright. */
  filterRoot: string
  /** Camel case, as it appears in the response body. */
  payloadKey: string
  filterMember: FilterMember
  /** Two types answer only rollup and dailyRollup. Reading them is M1c's problem, not ours. */
  listSupported: boolean
  scope: string
  target: MappingTarget
  /** Our name for the thing, which is not always Google's. */
  metric: string
  agg: SampleAgg
  unit: string
  /** Path within the payload object to the raw value, dotted. */
  valuePath: string
  /** Written per minute rather than per sample. Only heart rate needs it today. */
  downsampleToMinute: boolean
  /**
   * How far back the first backfill walks for this type, in days. Per type because the volumes
   * differ by three orders of magnitude: M0 measured heart rate at 23 MB of raw JSON per
   * person-day and every other type together under 0.8M rows per person-year.
   */
  backfillHorizonDays: number
  /**
   * Fetched and archived, but not mapped to tier 2 yet. Set when a type carries a
   * sub-dimension a flat sample row cannot hold without a derivation decision.
   */
  mappingDeferred?: true
}

// agg records how we computed the row, not how a rollup should combine it. A value the source
// reported is raw; only downsampleToMinute produces min, mean and max. Which aggregates are
// meaningful for a metric belongs to M2's metric catalogue, which is where a rollup asks.

const ACTIVITY = 'googlehealth.activity_and_fitness.readonly'
const METRICS = 'googlehealth.health_metrics_and_measurements.readonly'
const SLEEP = 'googlehealth.sleep.readonly'
const NUTRITION = 'googlehealth.nutrition.readonly'

export const DEFAULT_BACKFILL_HORIZON_DAYS = 1825
const DENSE_HORIZON_DAYS = 60
const NIGHTLY_HORIZON_DAYS = 365

const listable = (
  id: string, payloadKey: string, filterMember: FilterMember, scope: string,
  metric: string, unit: string, valuePath: string,
  extra: Partial<DataType> = {},
): DataType => ({
  id,
  filterRoot: id.replaceAll('-', '_'),
  payloadKey,
  filterMember,
  listSupported: true,
  scope,
  target: 'samples',
  metric,
  agg: 'raw',
  unit,
  valuePath,
  downsampleToMinute: false,
  backfillHorizonDays: DEFAULT_BACKFILL_HORIZON_DAYS,
  ...extra,
})

export const DATA_TYPES: readonly DataType[] = [
  listable('steps', 'steps', 'interval.start_time', ACTIVITY, 'steps', 'count', 'count'),
  listable('distance', 'distance', 'interval.start_time', ACTIVITY, 'distance', 'millimeters', 'millimeters'),
  // Sub-dimension: activity level. The payload holds an array,
  // activeMinutes.activeMinutesByActivityLevel[], one point per level per interval, which a
  // flat sample row cannot resolve. Archived at tier 1; summing across levels or encoding the
  // level into the metric name is a derivation decision for M2, not this catalogue.
  listable('active-minutes', 'activeMinutes', 'interval.start_time', ACTIVITY, 'active_minutes', 'minutes', 'activeMinutesByActivityLevel', { mappingDeferred: true }),
  // Sub-dimension: heart rate zone. activeZoneMinutes.heartRateZone varies within one interval,
  // so several points would share the samples natural key and collide on upsert. Same deferral
  // as active-minutes above.
  listable('active-zone-minutes', 'activeZoneMinutes', 'interval.start_time', ACTIVITY, 'active_zone_minutes', 'minutes', 'activeZoneMinutes', { mappingDeferred: true }),
  listable('active-energy-burned', 'activeEnergyBurned', 'interval.start_time', ACTIVITY, 'active_energy', 'kcal', 'kcal'),

  listable('heart-rate', 'heartRate', 'sample_time.physical_time', METRICS, 'heart_rate', 'bpm', 'beatsPerMinute', { downsampleToMinute: true, backfillHorizonDays: DENSE_HORIZON_DAYS }),
  listable('heart-rate-variability', 'heartRateVariability', 'sample_time.physical_time', METRICS, 'hrv', 'milliseconds', 'rootMeanSquareOfSuccessiveDifferencesMilliseconds', { backfillHorizonDays: NIGHTLY_HORIZON_DAYS }),
  listable('oxygen-saturation', 'oxygenSaturation', 'sample_time.physical_time', METRICS, 'spo2', 'percent', 'percentage', { backfillHorizonDays: NIGHTLY_HORIZON_DAYS }),
  listable('weight', 'weight', 'sample_time.physical_time', METRICS, 'weight', 'grams', 'weightGrams'),
  listable('body-fat', 'bodyFat', 'sample_time.physical_time', METRICS, 'body_fat', 'percent', 'percentage'),

  listable('daily-resting-heart-rate', 'dailyRestingHeartRate', 'date', METRICS, 'resting_heart_rate', 'bpm', 'beatsPerMinute'),
  // averageHeartRateVariabilityMilliseconds is the day's overall figure. A deep-sleep-only
  // variant also exists, deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds, and was
  // deliberately not chosen: daily_hrv means the whole day, and the deep sleep field would
  // quietly answer a narrower question.
  listable('daily-heart-rate-variability', 'dailyHeartRateVariability', 'date', METRICS, 'daily_hrv', 'milliseconds', 'averageHeartRateVariabilityMilliseconds'),
  listable('daily-oxygen-saturation', 'dailyOxygenSaturation', 'date', METRICS, 'daily_spo2', 'percent', 'averagePercentage'),
  listable('daily-respiratory-rate', 'dailyRespiratoryRate', 'date', METRICS, 'respiratory_rate', 'breaths_per_minute', 'breathsPerMinute'),

  listable('sleep', 'sleep', 'interval.end_time', SLEEP, 'sleep', 'session', '', { target: 'sessions' }),
  listable('exercise', 'exercise', 'interval.civil_start_time', ACTIVITY, 'exercise', 'session', '', { target: 'sessions' }),

  listable('hydration-log', 'hydrationLog', 'interval.civil_start_time', NUTRITION, 'hydration', 'milliliters', 'amountConsumed.milliliters'),
  // This household has never logged food, so the field map has no observed shape for
  // nutrition-log. 'calories' is an unverified guess, not a measured value; kept fetchable and
  // archived, with mapping deferred until a real payload confirms or corrects the leaf.
  listable('nutrition-log', 'nutritionLog', 'interval.civil_start_time', NUTRITION, 'nutrition', 'kcal', 'calories', { mappingDeferred: true }),

  // Rejected list; supported actions are rollup, dailyRollup.
  { ...listable('total-calories', 'totalCalories', 'interval.start_time', ACTIVITY, 'total_calories', 'kcal', 'kcal'), listSupported: false },
  // Rejected list too, but one action more than total-calories above: reconcile, rollup, dailyRollup.
  { ...listable('floors', 'floors', 'interval.start_time', ACTIVITY, 'floors', 'count', 'count'), listSupported: false },
]

const BY_ID = new Map(DATA_TYPES.map((t) => [t.id, t]))

export function dataTypeById(id: string): DataType | undefined {
  return BY_ID.get(id)
}
