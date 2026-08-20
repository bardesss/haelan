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
   * Fetched and archived, but not mapped to tier 2 yet. Set when a type carries a
   * sub-dimension a flat sample row cannot hold without a derivation decision.
   */
  mappingDeferred?: true
}

// SAMPLE_AGGS is raw, min, mean, max, sum, count. There is deliberately no 'last' here: last is
// a tier 3 rollup aggregate over a day, and a sample is a reading rather than a summary. A
// weight reading and a daily resting heart rate both arrive as the value the source reports, so
// both are 'raw' at this tier and become 'last' only when M2 rolls them up.

const ACTIVITY = 'googlehealth.activity_and_fitness.readonly'
const METRICS = 'googlehealth.health_metrics_and_measurements.readonly'
const SLEEP = 'googlehealth.sleep.readonly'
const NUTRITION = 'googlehealth.nutrition.readonly'

const listable = (
  id: string, payloadKey: string, filterMember: FilterMember, scope: string,
  metric: string, agg: SampleAgg, unit: string, valuePath: string,
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
  agg,
  unit,
  valuePath,
  downsampleToMinute: false,
  ...extra,
})

export const DATA_TYPES: readonly DataType[] = [
  listable('steps', 'steps', 'interval.start_time', ACTIVITY, 'steps', 'sum', 'count', 'count'),
  listable('distance', 'distance', 'interval.start_time', ACTIVITY, 'distance', 'sum', 'millimeters', 'millimeters'),
  // Sub-dimension: activity level. The payload holds an array,
  // activeMinutes.activeMinutesByActivityLevel[], one point per level per interval, which a
  // flat sample row cannot resolve. Archived at tier 1; summing across levels or encoding the
  // level into the metric name is a derivation decision for M2, not this catalogue.
  listable('active-minutes', 'activeMinutes', 'interval.start_time', ACTIVITY, 'active_minutes', 'sum', 'minutes', 'activeMinutesByActivityLevel', { mappingDeferred: true }),
  // Sub-dimension: heart rate zone. activeZoneMinutes.heartRateZone varies within one interval,
  // so several points would share the samples natural key and collide on upsert. Same deferral
  // as active-minutes above.
  listable('active-zone-minutes', 'activeZoneMinutes', 'interval.start_time', ACTIVITY, 'active_zone_minutes', 'sum', 'minutes', 'activeZoneMinutes', { mappingDeferred: true }),
  listable('active-energy-burned', 'activeEnergyBurned', 'interval.start_time', ACTIVITY, 'active_energy', 'sum', 'kcal', 'kcal'),

  listable('heart-rate', 'heartRate', 'sample_time.physical_time', METRICS, 'heart_rate', 'mean', 'bpm', 'beatsPerMinute', { downsampleToMinute: true }),
  listable('heart-rate-variability', 'heartRateVariability', 'sample_time.physical_time', METRICS, 'hrv', 'mean', 'milliseconds', 'rootMeanSquareOfSuccessiveDifferencesMilliseconds'),
  listable('oxygen-saturation', 'oxygenSaturation', 'sample_time.physical_time', METRICS, 'spo2', 'mean', 'percent', 'percentage'),
  listable('weight', 'weight', 'sample_time.physical_time', METRICS, 'weight', 'raw', 'grams', 'weightGrams'),
  listable('body-fat', 'bodyFat', 'sample_time.physical_time', METRICS, 'body_fat', 'raw', 'percent', 'percentage'),

  listable('daily-resting-heart-rate', 'dailyRestingHeartRate', 'date', METRICS, 'resting_heart_rate', 'raw', 'bpm', 'beatsPerMinute'),
  // averageHeartRateVariabilityMilliseconds is the day's overall figure. A deep-sleep-only
  // variant also exists, deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds, and was
  // deliberately not chosen: daily_hrv means the whole day, and the deep sleep field would
  // quietly answer a narrower question.
  listable('daily-heart-rate-variability', 'dailyHeartRateVariability', 'date', METRICS, 'daily_hrv', 'raw', 'milliseconds', 'averageHeartRateVariabilityMilliseconds'),
  listable('daily-oxygen-saturation', 'dailyOxygenSaturation', 'date', METRICS, 'daily_spo2', 'mean', 'percent', 'averagePercentage'),
  listable('daily-respiratory-rate', 'dailyRespiratoryRate', 'date', METRICS, 'respiratory_rate', 'mean', 'breaths_per_minute', 'breathsPerMinute'),

  listable('sleep', 'sleep', 'interval.end_time', SLEEP, 'sleep', 'raw', 'session', '', { target: 'sessions' }),
  listable('exercise', 'exercise', 'interval.civil_start_time', ACTIVITY, 'exercise', 'raw', 'session', '', { target: 'sessions' }),

  listable('hydration-log', 'hydrationLog', 'interval.civil_start_time', NUTRITION, 'hydration', 'sum', 'milliliters', 'amountConsumed.milliliters'),
  // This household has never logged food, so the field map has no observed shape for
  // nutrition-log. 'calories' is an unverified guess, not a measured value; kept fetchable and
  // archived, with mapping deferred until a real payload confirms or corrects the leaf.
  listable('nutrition-log', 'nutritionLog', 'interval.civil_start_time', NUTRITION, 'nutrition', 'sum', 'kcal', 'calories', { mappingDeferred: true }),

  // Rejected list; supported actions are rollup, dailyRollup.
  { ...listable('total-calories', 'totalCalories', 'interval.start_time', ACTIVITY, 'total_calories', 'sum', 'kcal', 'kcal'), listSupported: false },
  // Rejected list too, but one action more than total-calories above: reconcile, rollup, dailyRollup.
  { ...listable('floors', 'floors', 'interval.start_time', ACTIVITY, 'floors', 'sum', 'count', 'count'), listSupported: false },
]

const BY_ID = new Map(DATA_TYPES.map((t) => [t.id, t]))

export function dataTypeById(id: string): DataType | undefined {
  return BY_ID.get(id)
}
