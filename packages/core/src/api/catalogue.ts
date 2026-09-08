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
const ECG = 'googlehealth.ecg.readonly'
const IRN = 'googlehealth.irn.readonly'
const NUTRITION = 'googlehealth.nutrition.readonly'
// The three most sensitive categories, each confirmed on the console's Data Access page on
// 2026-09-08 with Google's own description. Together with nutrition, four of the scopes this app
// requests are absent from the discovery document's `auth.oauth2.scopes` block - which is why that
// block is not treated as a list of what exists.
const REPRODUCTIVE = 'googlehealth.reproductive_health.readonly'
const SYMPTOMS = 'googlehealth.logged_symptoms.readonly'
const MINDFULNESS = 'googlehealth.mindfulness.readonly'

/**
 * Scopes a data type names that consent can never carry. Google's registry, read 2026-09-06 from
 * the discovery document's `auth.oauth2.scopes` block, defines eighteen scopes, and for four
 * categories - nutrition, reproductive_health, logged_symptoms and mindfulness - the only form is
 * `.writeonly`, which grants an app read-back of its own writes. haelan writes nothing to Google
 * Health, so a type under one of those four is unreadable to it no matter what is asked for.
 *
 * The scope constant survives anyway, because it is how the entries beneath it say which category
 * they belong to, and the category is the reason they cannot be fetched.
 */
/**
 * Scopes a data type may declare that consent cannot carry.
 *
 * Empty, and the emptiness is the point. It briefly held NUTRITION on the reasoning that
 * `auth.oauth2.scopes` in the v4 discovery document names no readonly form for the category. That
 * reasoning was wrong: the console's Data Access page lists `googlehealth.nutrition.readonly` with
 * a Google-authored description (probe/findings/scopes.md), and hydration-log returned 33 real
 * points under it (probe/findings/field-map.md). The registry is incomplete, so its silence is not
 * evidence of absence.
 *
 * Kept rather than deleted because the guard test needs somewhere to put a scope that is genuinely
 * unreachable, and because a future entry here is a claim that must be measured against the
 * console rather than inferred from the discovery document.
 */
export const UNGRANTABLE_SCOPES: readonly string[] = []

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

  // Group A: five ordinary scalars added to close the catalogue gap behind the v4 discovery
  // document. Measured 2026-09-06 against Height, CoreBodyTemperature, BloodGlucose, RunVO2Max
  // and Altitude; see .superpowers/sdd/2026-09-06-catalogue-catches-up/api-schemas.md. Each is a
  // number with a unit at an instant or over an interval - exactly what samples and mapSamples
  // already handle, so no new field or mechanism was needed, only five more listable() calls.
  // heightMillimeters and gainMillimeters are declared `string` in the schema (int64-as-string,
  // same convention as heart rate's beatsPerMinute); parseNumeric already accepts that shape.
  listable('height', 'height', 'sample_time.physical_time', METRICS, 'height', 'millimeters', 'heightMillimeters'),
  // measurementLocation (armpit, ear, forehead, ...) is context on the reading, not a metric of
  // its own - same reasoning as the four blood glucose context fields immediately below.
  listable('core-body-temperature', 'coreBodyTemperature', 'sample_time.physical_time', METRICS, 'core_body_temperature', 'celsius', 'temperatureCelsius'),
  // Blood glucose carries four context enums on the reading itself - mealType, measurementTiming,
  // specimen and measurementSource - describing how and when the sample was taken. None becomes
  // a metric: a reading's meal context is a fact about that reading, and splitting on any of them
  // would produce four or five sparse series where a household has one number to look at.
  listable('blood-glucose', 'bloodGlucose', 'sample_time.physical_time', METRICS, 'blood_glucose', 'mg_dl', 'bloodGlucoseMilligramsPerDeciliter'),
  listable('run-vo2-max', 'runVo2Max', 'sample_time.physical_time', METRICS, 'run_vo2_max', 'ml_kg_min', 'runVo2Max'),
  // interval.start_time, not interval.end_time: an altitude gain belongs to when the climb
  // began, unlike sleep (which is filed at its end - the one documented exception).
  listable('altitude', 'altitude', 'interval.start_time', ACTIVITY, 'altitude_gain', 'millimeters', 'gainMillimeters'),

  // Group B: four interval types, measured 2026-09-06 against SedentaryPeriod, ActivityLevel,
  // TimeInHeartRateZone and SwimLengthsData; see the same api-schemas.md as Group A. All four
  // carry an ObservationTimeInterval and nothing else that identifies when the row belongs -
  // filterMember is interval.start_time for the same reason distance and altitude use it. Three
  // of the four have no value field at all: the interval itself is the only measurement, which is
  // what `durationMinutes` (Task 1's parseIntervalMinutes) exists for - do not go looking for a
  // valuePath here, there was never one to find.
  //
  // sedentary-period has nothing to split on, so it is an ordinary duration type.
  listable('sedentary-period', 'sedentaryPeriod', 'interval.start_time', ACTIVITY, 'sedentary_minutes', 'minutes', '', {
    durationMinutes: true,
  }),
  // activity-level splits on activityLevelType the same way active-minutes splits on
  // activityLevel: one metric per level, value is the interval's own length. The enum's
  // UNSPECIFIED member is deliberately left unnamed - an unspecified level is not a level, and
  // naming it would produce a metric meaning "we do not know", which mapSamples' skip-unnamed-key
  // behaviour (see SubDimension's own doc comment) is exactly the right response to.
  listable('activity-level', 'activityLevel', 'interval.start_time', ACTIVITY, 'activity_level', 'minutes', '', {
    subDimension: {
      keyPath: 'activityLevelType',
      valuePath: '',
      durationMinutes: true,
      metricByKey: {
        SEDENTARY: 'activity_level_sedentary_minutes',
        LIGHTLY_ACTIVE: 'activity_level_lightly_active_minutes',
        MODERATELY_ACTIVE: 'activity_level_moderately_active_minutes',
        VERY_ACTIVE: 'activity_level_very_active_minutes',
      },
    },
  }),
  // time-in-heart-rate-zone splits on heartRateZoneType the same way active-zone-minutes splits
  // on heartRateZone, but the zone vocabulary here is Google's newer four-value one (LIGHT,
  // MODERATE, VIGOROUS, PEAK), not active-zone-minutes' three-value FAT_BURN/CARDIO/PEAK - the two
  // types are not the same zones under different names, so their metrics are kept separate rather
  // than merged. HEART_RATE_ZONE_TYPE_UNSPECIFIED is left unnamed for the same reason as above.
  listable('time-in-heart-rate-zone', 'timeInHeartRateZone', 'interval.start_time', ACTIVITY, 'time_in_heart_rate_zone', 'minutes', '', {
    subDimension: {
      keyPath: 'heartRateZoneType',
      valuePath: '',
      durationMinutes: true,
      metricByKey: {
        LIGHT: 'time_in_heart_rate_zone_light_minutes',
        MODERATE: 'time_in_heart_rate_zone_moderate_minutes',
        VIGOROUS: 'time_in_heart_rate_zone_vigorous_minutes',
        PEAK: 'time_in_heart_rate_zone_peak_minutes',
      },
    },
  }),
  // swim-lengths-data is the exception in its own group: strokeCount is a real value (int64 as
  // string, same convention parseNumeric already accepts everywhere else), not a duration, so it
  // does not get durationMinutes. The split is still on an enum, swimStrokeType, so it still goes
  // through subDimension - a count sub-dimension looks the same as a duration one except for which
  // leaf is read. SWIM_STROKE_TYPE_UNSPECIFIED is left unnamed for the same reason as above.
  listable('swim-lengths-data', 'swimLengthsData', 'interval.start_time', ACTIVITY, 'swim_lengths', 'count', '', {
    subDimension: {
      keyPath: 'swimStrokeType',
      valuePath: 'strokeCount',
      metricByKey: {
        FREESTYLE: 'swim_lengths_freestyle_strokes',
        BACKSTROKE: 'swim_lengths_backstroke_strokes',
        BREASTSTROKE: 'swim_lengths_breaststroke_strokes',
        BUTTERFLY: 'swim_lengths_butterfly_strokes',
      },
    },
  }),

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
  // The valuePath is measured now rather than guessed: read off the v4 schema on 2026-09-06, the
  // leaf is `energy.kcal`, correcting the `calories` this entry invented. Mapping stays deferred
  // for a different and smaller reason - the payload also carries `nutrients[]`, `totalFat` and
  // `totalCarbohydrate`, so a single kcal column answers less than the type holds, and the
  // household has logged no food at all (0 points in probe/findings/field-map.md) for the shape of
  // a fuller mapping to be designed against.
  listable('nutrition-log', 'nutritionLog', 'interval.civil_start_time', NUTRITION, 'nutrition', 'kcal', 'energy.kcal', { mappingDeferred: true }),

  // Group F: six data types named by neither the release notes nor the drift check - the drift
  // check sees only rollup-capable types named in prose. Measured 2026-09-06 against VO2Max,
  // DailyVo2Max, BasalEnergyBurned, DailySleepTemperatureDerivations,
  // RespiratoryRateSleepSummary and DailyHeartRateZones; see
  // .superpowers/sdd/2026-09-06-catalogue-catches-up/task-11-brief.md for the measured
  // payloadKey/clock/value/unit table this group is built from.
  //
  // vo2-max is the generic, unqualified reading, so it takes the bare metric name 'vo2_max' -
  // the same convention as hrv/daily_hrv and spo2/daily_spo2. run-vo2-max, the running-specific
  // reading, is qualified instead ('run_vo2_max'); daily-vo2-max's civil-date summary follows the
  // daily_ prefix convention. Three VO2 max types now exist (from running, a general measurement,
  // and a daily summary) and each needs a name a reader can tell apart.
  listable('vo2-max', 'vo2Max', 'sample_time.physical_time', METRICS, 'vo2_max', 'ml_kg_min', 'vo2Max'),
  listable('daily-vo2-max', 'dailyVo2Max', 'date', METRICS, 'daily_vo2_max', 'ml_kg_min', 'vo2Max'),
  // interval.start_time, the same convention active-energy-burned and altitude use.
  listable('basal-energy-burned', 'basalEnergyBurned', 'interval.start_time', ACTIVITY, 'basal_energy', 'kcal', 'kcal'),
  // DailySleepTemperatureDerivations also carries baselineTemperatureCelsius (the 30-day
  // baseline) and relativeNightlyStddev30dCelsius (that baseline's spread). nightlyTemperature
  // Celsius is the night's own figure and is mapped for the same reason
  // daily-heart-rate-variability picks the whole-night HRV over its deep-sleep-only variant: the
  // other two fields would quietly answer a narrower question than "this night's temperature".
  listable('daily-sleep-temperature-derivations', 'dailySleepTemperatureDerivations', 'date', SLEEP, 'sleep_temperature', 'celsius', 'nightlyTemperatureCelsius'),
  // RespiratoryRateSleepSummary also carries remSleepStats, deepSleepStats and lightSleepStats,
  // each shaped like fullSleepStats. fullSleepStats.breathsPerMinute is the whole night's figure
  // and is mapped for the same reason as above; the three stage-only variants are archived, not
  // mapped. The metric cannot be named respiratory_rate - daily-respiratory-rate already owns it.
  listable('respiratory-rate-sleep-summary', 'respiratoryRateSleepSummary', 'sample_time.physical_time', SLEEP, 'sleep_respiratory_rate', 'breaths_per_minute', 'fullSleepStats.breathsPerMinute'),
  // Sub-dimension: heart rate zone ceiling. heartRateZones[] holds
  // {heartRateZoneType, minBeatsPerMinute, maxBeatsPerMinute}, both declared `string` in the
  // schema (int64-as-string, same convention parseNumeric already accepts everywhere else).
  // Only maxBeatsPerMinute is mapped: minBeatsPerMinute is archived rather than given its own
  // metric, because one zone's floor is the previous zone's ceiling - mapping both would
  // double-count the same boundary under two names. This is a threshold the day's zones were
  // computed with, not a measurement, so the metric names say so (_max_bpm) rather than reading
  // like a reading of anything. HEART_RATE_ZONE_TYPE_UNSPECIFIED is left unnamed for the same
  // reason as time-in-heart-rate-zone above.
  listable('daily-heart-rate-zones', 'dailyHeartRateZones', 'date', ACTIVITY, 'daily_heart_rate_zones', 'bpm', '', {
    subDimension: {
      arrayPath: 'heartRateZones',
      keyPath: 'heartRateZoneType',
      valuePath: 'maxBeatsPerMinute',
      metricByKey: {
        LIGHT: 'heart_rate_zone_light_max_bpm',
        MODERATE: 'heart_rate_zone_moderate_max_bpm',
        VIGOROUS: 'heart_rate_zone_vigorous_max_bpm',
        PEAK: 'heart_rate_zone_peak_max_bpm',
      },
    },
  }),

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
