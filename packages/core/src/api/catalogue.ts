import type { SampleAgg } from '../db/schema/derived.ts'

// The filterable member differs per type across five shapes. The discovery document documents the
// patterns ({interval_data_type}.interval.start_time, {sample_data_type}.sample_time.physical_time,
// {daily_summary_data_type}.date, and sleep.interval.end_time as a sleep specific case), which an
// earlier version of this comment said it did not; four of the five values below match one of those
// patterns. The fifth has no documented counterpart and is noted where it appears. Every value here
// was measured against the live API in M0; see probe/findings/field-map.md.
export const FILTER_MEMBERS = [
  'interval.start_time',
  'sample_time.physical_time',
  'date',
  'interval.end_time',
  'interval.civil_start_time', // no documented counterpart; measured against the live API, not published
] as const
export type FilterMember = (typeof FILTER_MEMBERS)[number]

export type MappingTarget = 'samples' | 'sessions'

export type TypeTier = 'intraday' | 'daily'

/**
 * A type whose payload carries a dimension a flat sample row cannot hold. Rather than a column,
 * the dimension goes into the metric name, so each value becomes an ordinary metric with an
 * ordinary rollup. `arrayPath` is set when the values arrive as an array inside one point, and
 * left unset when each value is its own point.
 *
 * `metricByKey` is exhaustive on purpose. A key it does not name is skipped rather than turned
 * into a metric no catalogue entry describes; the enum sets are in probe/findings/field-map.md.
 */
export interface SubDimension {
  arrayPath?: string
  keyPath: string
  valuePath: string
  metricByKey: Readonly<Record<string, string>>
  /**
   * The value is the interval's own length rather than a leaf read through `valuePath`. Exists
   * because some enum-keyed types (an activity period keyed by its kind, say) carry no numeric
   * field at all - the interval itself is the only measurement.
   */
  durationMinutes?: true
}

export const ACTIONS = ['list', 'rollUp', 'dailyRollUp', 'reconcile'] as const
export type Action = (typeof ACTIONS)[number]

export interface DataType {
  /** Kebab case, as it appears in the URL path. */
  id: string
  /** Snake case, as the filter parser demands. Rejects the camel form outright. */
  filterRoot: string
  /** Camel case, as it appears in the response body. */
  payloadKey: string
  /**
   * Which member a `list` filter is built on. Null for a type that answers no `list` at all:
   * the rollup methods take a civil interval and no filter, and probe/findings/rollup-methods.md
   * records that the filter grammar does not apply to them. A member named here for a type that
   * has none is an assertion nothing measured.
   */
  filterMember: FilterMember | null
  /**
   * Read actions observed to work for this type: `probe/findings/rollup-methods.md`, from the
   * `allowed_actions` metadata the API returns when it refuses one. An action's absence here
   * means it has not been probed, not that the API refuses it. `list` and `rollUp` are neither
   * opposites nor a partition, which is why this is a set and not the boolean it replaced.
   */
  actions: readonly Action[]
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
   * Which horizon this type walks to. Intraday types report many times a day and are capped;
   * daily types are one row a day, so five years of them is a rounding error on disk.
   */
  tier: TypeTier
  /**
   * Fetched and archived, but not mapped to tier 2 yet. Set when a type's shape is not yet
   * confirmed against a real payload, so a valuePath would be a guess.
   */
  mappingDeferred?: true
  /** Set when a dimension in the payload becomes part of the metric name instead of a column. */
  subDimension?: SubDimension
  /**
   * The value is the interval's own length rather than a `valuePath` read. Exists because four
   * of the sixteen types the catalogue is missing carry no other field - sedentary-period has
   * nothing but an interval - so the idea is expressed once here instead of once per type.
   */
  durationMinutes?: true
}

// agg records how we computed the row, not how a rollup should combine it. A value the source
// reported is raw; only downsampleToMinute produces min, mean and max. Which aggregates are
// meaningful for a metric belongs to M2's metric catalogue, which is where a rollup asks.

const ACTIVITY = 'googlehealth.activity_and_fitness.readonly'
const METRICS = 'googlehealth.health_metrics_and_measurements.readonly'
const SLEEP = 'googlehealth.sleep.readonly'
const NUTRITION = 'googlehealth.nutrition.readonly'

/**
 * The cap on types that report many times a day. Cost is density multiplied by horizon, and
 * measuring 29 days of one person's real data put active-energy-burned at 932 rows a day
 * against a 1825-day horizon: 759 MB, 56 percent of a 1.35 GB projection. Heart rate was capped
 * for being densest per day; these four were never capped at all.
 *
 * The cap itself is a storage choice, not a limit the API imposes: a live account measured
 * intraday heart rate at full resolution across all 209 days it has existed, with no thinning by
 * age, so 365 was chosen to give a year of minute-level history while still bounding disk. At the
 * 2-year default horizon this costs 1.05 GB per person, up from 0.26 GB at the old 90-day cap.
 */
export const INTRADAY_HORIZON_DAYS = 365
export const USER_HORIZON_CHOICES = [365, 730, 1825] as const
export const DEFAULT_USER_HORIZON_DAYS = 730

/**
 * The only place either horizon is read. Status, the backfill walk and the wizard all resolve
 * through this, so the number on screen cannot diverge from the number being walked.
 */
export function horizonDaysFor(type: DataType, userHorizonDays: number): number {
  return type.tier === 'intraday' ? INTRADAY_HORIZON_DAYS : userHorizonDays
}

const listable = (
  id: string, payloadKey: string, filterMember: FilterMember | null, scope: string,
  metric: string, unit: string, valuePath: string,
  extra: Partial<DataType> = {},
): DataType => ({
  id,
  filterRoot: id.replaceAll('-', '_'),
  payloadKey,
  filterMember,
  actions: ['list'],
  scope,
  target: 'samples',
  metric,
  agg: 'raw',
  unit,
  valuePath,
  downsampleToMinute: false,
  tier: 'daily',
  ...extra,
})

export const DATA_TYPES: readonly DataType[] = [
  listable('steps', 'steps', 'interval.start_time', ACTIVITY, 'steps', 'count', 'count', { tier: 'intraday', actions: ['list', 'dailyRollUp'] }),
  listable('distance', 'distance', 'interval.start_time', ACTIVITY, 'distance', 'millimeters', 'millimeters', { tier: 'intraday' }),
  // Sub-dimension: activity level. The payload holds an array,
  // activeMinutes.activeMinutesByActivityLevel[], one point per level per interval, which a
  // flat sample row cannot resolve, so the level goes into the metric name instead.
  listable('active-minutes', 'activeMinutes', 'interval.start_time', ACTIVITY, 'active_minutes', 'minutes', '', {
    tier: 'intraday',
    subDimension: {
      arrayPath: 'activeMinutesByActivityLevel',
      keyPath: 'activityLevel',
      valuePath: 'activeMinutes',
      metricByKey: {
        LIGHT: 'active_minutes_light',
        MODERATE: 'active_minutes_moderate',
        VIGOROUS: 'active_minutes_vigorous',
      },
    },
  }),
  // Sub-dimension: heart rate zone. One metric per zone is what makes each of them an ordinary
  // metric with an ordinary rollup, same as the activity level above. The natural key collision
  // this deferral originally feared was measured on this branch and does not occur: no interval
  // in the sample carried more than one zone, per probe/findings/field-map.md.
  listable('active-zone-minutes', 'activeZoneMinutes', 'interval.start_time', ACTIVITY, 'active_zone_minutes', 'minutes', '', {
    tier: 'intraday',
    subDimension: {
      keyPath: 'heartRateZone',
      valuePath: 'activeZoneMinutes',
      metricByKey: {
        FAT_BURN: 'active_zone_minutes_fat_burn',
        CARDIO: 'active_zone_minutes_cardio',
        PEAK: 'active_zone_minutes_peak',
      },
    },
  }),
  listable('active-energy-burned', 'activeEnergyBurned', 'interval.start_time', ACTIVITY, 'active_energy', 'kcal', 'kcal', { tier: 'intraday' }),

  listable('heart-rate', 'heartRate', 'sample_time.physical_time', METRICS, 'heart_rate', 'bpm', 'beatsPerMinute', { downsampleToMinute: true, tier: 'intraday', actions: ['list', 'dailyRollUp'] }),
  listable('heart-rate-variability', 'heartRateVariability', 'sample_time.physical_time', METRICS, 'hrv', 'milliseconds', 'rootMeanSquareOfSuccessiveDifferencesMilliseconds', { tier: 'intraday' }),
  listable('oxygen-saturation', 'oxygenSaturation', 'sample_time.physical_time', METRICS, 'spo2', 'percent', 'percentage', { tier: 'intraday' }),
  listable('weight', 'weight', 'sample_time.physical_time', METRICS, 'weight', 'grams', 'weightGrams'),
  listable('body-fat', 'bodyFat', 'sample_time.physical_time', METRICS, 'body_fat', 'percent', 'percentage'),

  listable('daily-resting-heart-rate', 'dailyRestingHeartRate', 'date', METRICS, 'resting_heart_rate', 'bpm', 'beatsPerMinute', { actions: ['list', 'reconcile'] }),
  // averageHeartRateVariabilityMilliseconds is the day's overall figure. A deep-sleep-only
  // variant also exists, deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds, and was
  // deliberately not chosen: daily_hrv means the whole day, and the deep sleep field would
  // quietly answer a narrower question.
  listable('daily-heart-rate-variability', 'dailyHeartRateVariability', 'date', METRICS, 'daily_hrv', 'milliseconds', 'averageHeartRateVariabilityMilliseconds'),
  listable('daily-oxygen-saturation', 'dailyOxygenSaturation', 'date', METRICS, 'daily_spo2', 'percent', 'averagePercentage'),
  listable('daily-respiratory-rate', 'dailyRespiratoryRate', 'date', METRICS, 'respiratory_rate', 'breaths_per_minute', 'breathsPerMinute'),

  listable('sleep', 'sleep', 'interval.end_time', SLEEP, 'sleep', 'session', '', { target: 'sessions', actions: ['list', 'reconcile'] }),
  listable('exercise', 'exercise', 'interval.civil_start_time', ACTIVITY, 'exercise', 'session', '', { target: 'sessions' }),

  listable('hydration-log', 'hydrationLog', 'interval.civil_start_time', NUTRITION, 'hydration', 'milliliters', 'amountConsumed.milliliters'),
  // This household has never logged food, so the field map has no observed shape for
  // nutrition-log. 'calories' is an unverified guess, not a measured value; kept fetchable and
  // archived, with mapping deferred until a real payload confirms or corrects the leaf.
  listable('nutrition-log', 'nutritionLog', 'interval.civil_start_time', NUTRITION, 'nutrition', 'kcal', 'calories', { mappingDeferred: true }),

  // Rejects list, and takes no filter at all: see filterMember above. Measured request and
  // response shapes: probe/findings/rollup-methods.md.
  {
    ...listable('total-calories', 'totalCalories', null, ACTIVITY, 'total_calories', 'kcal', 'kcalSum'),
    actions: ['rollUp', 'dailyRollUp'],
  },
  {
    ...listable('floors', 'floors', null, ACTIVITY, 'floors', 'count', 'countSum'),
    actions: ['rollUp', 'dailyRollUp', 'reconcile'],
  },
]

const BY_ID = new Map(DATA_TYPES.map((t) => [t.id, t]))

export function dataTypeById(id: string): DataType | undefined {
  return BY_ID.get(id)
}

export function supports(t: DataType, action: Action): boolean {
  return t.actions.includes(action)
}
