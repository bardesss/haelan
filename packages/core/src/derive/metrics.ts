// What DATA_TYPES is to Google, this is to the dashboard. DATA_TYPES describes what the API
// offers and how to fetch it; this describes what a metric means once it is ours. They change
// for different reasons and on different clocks, which is why they are two modules.
//
// A metric declares its own unit. The truth test in metrics.test.ts holds it to the matching
// DATA_TYPES entry's unit wherever one exists; the sleep family, which has no data type, is
// hand-authored instead.

export const DAILY_AGGS = ['min', 'mean', 'max', 'last', 'sum', 'count', 'p50'] as const
export type DailyAgg = (typeof DAILY_AGGS)[number]

export interface MetricSpec {
  /** Which aggregates are meaningful. Summing heart rate is not a number anyone means. */
  aggs: readonly DailyAgg[]
  /** Decimals to show, in the unit this spec declares. */
  precision: number
  /** Whether a higher reading is better, worse, or neither. Read by M3's baseline bands. */
  direction: 'up' | 'down' | 'neutral'
  /**
   * What the number is in. On the metric rather than on DATA_TYPES, because M2a's sub-dimension
   * metrics and M2c's sleep metrics have no data type of their own to inherit one from, which is
   * what made the M2 ruling ("unit stays on DATA_TYPES") unable to describe half the catalogue.
   */
  unit: string
}

const TOTAL = { aggs: ['sum'], precision: 0, direction: 'up' } as const
const SPOT = { aggs: ['last', 'mean'], precision: 1, direction: 'neutral' } as const

export const METRICS: Record<string, MetricSpec> = {
  steps: { ...TOTAL, unit: 'count' },
  distance: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'millimeters' },
  active_energy: { ...TOTAL, unit: 'kcal' },
  total_calories: { ...TOTAL, unit: 'kcal' },
  floors: { ...TOTAL, unit: 'count' },
  hydration: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'milliliters' },
  nutrition: { ...TOTAL, unit: 'kcal' },
  // food (catalogue.ts) is mappingDeferred with no clock to ever produce a row from, so this spec
  // is never read by a rollup - it exists only because this test file's own completeness guard
  // holds every samples-target catalogue entry to a spec, deferred or not, the same as nutrition
  // just above.
  food: { aggs: ['last'], precision: 0, direction: 'neutral', unit: 'kcal' },

  // One metric per activity level and per heart rate zone. The sub-dimension is in the name,
  // which is what lets each be an ordinary metric with an ordinary rollup. The six suffixes are
  // the enum values probe/findings/field-map.md records, measured rather than guessed.
  active_minutes_light: { ...TOTAL, unit: 'minutes' },
  active_minutes_moderate: { ...TOTAL, unit: 'minutes' },
  active_minutes_vigorous: { ...TOTAL, unit: 'minutes' },
  active_zone_minutes_fat_burn: { ...TOTAL, unit: 'minutes' },
  active_zone_minutes_cardio: { ...TOTAL, unit: 'minutes' },
  active_zone_minutes_peak: { ...TOTAL, unit: 'minutes' },

  // Intraday series: min, mean and max are three different readings of the same day and a card
  // shows all three. p50 is carried because a mean over a day with one glitching hour is not
  // the middle of anything. count is the basis a reading is shown against, not a metric in its
  // own right: the number of samples behind the day's figure.
  heart_rate: { aggs: ['min', 'mean', 'max', 'p50', 'count'], precision: 0, direction: 'down', unit: 'bpm' },
  hrv: { aggs: ['min', 'mean', 'max', 'count'], precision: 0, direction: 'up', unit: 'milliseconds' },
  spo2: { aggs: ['min', 'mean', 'max', 'count'], precision: 1, direction: 'up', unit: 'percent' },

  // Episodic. A weight is a reading, not a rate, so the day's figure is the last one taken.
  weight: { aggs: ['last', 'mean'], precision: 1, direction: 'neutral', unit: 'grams' },
  body_fat: { ...SPOT, unit: 'percent' },

  // Group A scalars, same episodic-reading shape as weight and body_fat above. height barely
  // moves for an adult, so 'neutral' rather than a direction that would imply taller or shorter
  // is the goal; the same reasoning as body_fat's 'neutral' applies to core_body_temperature and
  // blood_glucose, whose healthy range is not a monotonic "more/less is better" line.
  // run_vo2_max is the one exception with an unambiguous direction: a higher cardiorespiratory
  // fitness reading is better, the same judgment already made for hrv above.
  height: { aggs: ['last', 'mean'], precision: 0, direction: 'neutral', unit: 'millimeters' },
  core_body_temperature: { ...SPOT, unit: 'celsius' },
  blood_glucose: { aggs: ['last', 'mean'], precision: 0, direction: 'neutral', unit: 'mg_dl' },
  run_vo2_max: { aggs: ['last', 'mean'], precision: 1, direction: 'up', unit: 'ml_kg_min' },
  // Unlike the four spot readings above, an altitude gain accrues over an interval the same way
  // distance and floors do, so it sums for the day rather than taking the last value.
  altitude_gain: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'millimeters' },

  // Group F scalars, measured 2026-09-06. vo2_max is the generic, unqualified reading and takes
  // the bare name, the same convention as hrv/daily_hrv and spo2/daily_spo2; daily_vo2_max is its
  // daily summary. Both keep run_vo2_max's 'up' direction, the same judgment, so three VO2 max
  // series never collide. basal_energy is 'neutral' rather than 'up' like active_energy: a higher
  // resting metabolic rate is not itself an activity goal the way burning more active calories is.
  // sleep_temperature and sleep_respiratory_rate are 'neutral', the same reasoning as
  // core_body_temperature and respiratory_rate - a night's reading is not read as simply better
  // when higher.
  vo2_max: { aggs: ['last', 'mean'], precision: 1, direction: 'up', unit: 'ml_kg_min' },
  daily_vo2_max: { aggs: ['last'], precision: 1, direction: 'up', unit: 'ml_kg_min' },
  basal_energy: { aggs: ['sum'], precision: 0, direction: 'neutral', unit: 'kcal' },
  sleep_temperature: { aggs: ['last'], precision: 1, direction: 'neutral', unit: 'celsius' },
  sleep_respiratory_rate: { aggs: ['last'], precision: 1, direction: 'neutral', unit: 'breaths_per_minute' },
  // One metric per heart rate zone ceiling - a threshold the day's zones were computed with, not
  // a measurement, hence 'neutral' and the _max_bpm name rather than a reading-style one.
  heart_rate_zone_light_max_bpm: { aggs: ['last'], precision: 0, direction: 'neutral', unit: 'bpm' },
  heart_rate_zone_moderate_max_bpm: { aggs: ['last'], precision: 0, direction: 'neutral', unit: 'bpm' },
  heart_rate_zone_vigorous_max_bpm: { aggs: ['last'], precision: 0, direction: 'neutral', unit: 'bpm' },
  heart_rate_zone_peak_max_bpm: { aggs: ['last'], precision: 0, direction: 'neutral', unit: 'bpm' },

  // Group B: four interval types whose value is a duration or a count, not a spot reading, so
  // they sum for the day the same way distance does. sedentary-period has no split; the other
  // three have one metric per named enum value, same shape as active_minutes_* and
  // active_zone_minutes_* above. direction is 'down' for sedentary (less is better) and 'up' for
  // the active levels and heart rate zones (more is better); swim strokes are 'neutral' - a count
  // of strokes taken is not itself a fitness judgement the way minutes spent moving is.
  sedentary_minutes: { aggs: ['sum'], precision: 0, direction: 'down', unit: 'minutes' },
  activity_level_sedentary_minutes: { aggs: ['sum'], precision: 0, direction: 'down', unit: 'minutes' },
  activity_level_lightly_active_minutes: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'minutes' },
  activity_level_moderately_active_minutes: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'minutes' },
  activity_level_very_active_minutes: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'minutes' },
  time_in_heart_rate_zone_light_minutes: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'minutes' },
  time_in_heart_rate_zone_moderate_minutes: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'minutes' },
  time_in_heart_rate_zone_vigorous_minutes: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'minutes' },
  time_in_heart_rate_zone_peak_minutes: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'minutes' },
  swim_lengths_freestyle_strokes: { aggs: ['sum'], precision: 0, direction: 'neutral', unit: 'count' },
  swim_lengths_backstroke_strokes: { aggs: ['sum'], precision: 0, direction: 'neutral', unit: 'count' },
  swim_lengths_breaststroke_strokes: { aggs: ['sum'], precision: 0, direction: 'neutral', unit: 'count' },
  swim_lengths_butterfly_strokes: { aggs: ['sum'], precision: 0, direction: 'neutral', unit: 'count' },

  // One value a day from the API already. last is the whole story; mean would average one number.
  resting_heart_rate: { aggs: ['last'], precision: 0, direction: 'down', unit: 'bpm' },
  daily_hrv: { aggs: ['last'], precision: 0, direction: 'up', unit: 'milliseconds' },
  daily_spo2: { aggs: ['last'], precision: 1, direction: 'up', unit: 'percent' },
  respiratory_rate: { aggs: ['last'], precision: 1, direction: 'neutral', unit: 'breaths_per_minute' },

  // Sleep, derived from sessions and their stage segments rather than from samples, which is why
  // the data type `sleep` has no entry of its own. Minutes are summed over the night's pieces;
  // the three one-per-night figures take `last` because a night has exactly one of each. No data
  // type exists to take a unit from, so these eleven are hand-authored.
  sleep_asleep_minutes: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'minutes' },
  sleep_awake_minutes: { aggs: ['sum'], precision: 0, direction: 'down', unit: 'minutes' },
  sleep_in_bed_minutes: { aggs: ['sum'], precision: 0, direction: 'neutral', unit: 'minutes' },
  sleep_deep_minutes: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'minutes' },
  sleep_light_minutes: { aggs: ['sum'], precision: 0, direction: 'neutral', unit: 'minutes' },
  sleep_rem_minutes: { aggs: ['sum'], precision: 0, direction: 'up', unit: 'minutes' },
  sleep_efficiency: { aggs: ['last'], precision: 0, direction: 'up', unit: 'percent' },
  // Minutes from the local midnight of the row's date, which is the morning the night ended, so
  // an 23:30 bedtime is -30. One signed scale rather than a time plus a column saying which day.
  // The unit is a clock offset, not a duration, which 'minutes' alone does not say: -30 is not
  // thirty minutes of anything, it is thirty minutes before midnight.
  sleep_bedtime_minutes: {
    aggs: ['last'], precision: 0, direction: 'neutral', unit: 'minutes_from_local_midnight',
  },
  sleep_waketime_minutes: {
    aggs: ['last'], precision: 0, direction: 'neutral', unit: 'minutes_from_local_midnight',
  },
  sleep_nap_count: { aggs: ['count'], precision: 0, direction: 'neutral', unit: 'count' },
  sleep_nap_minutes: { aggs: ['sum'], precision: 0, direction: 'neutral', unit: 'minutes' },

  // Workouts, derived from sessions the way the sleep family is, and named for what they measure
  // rather than for the data type: `exercise` stays undefined below, same as `sleep` does.
  workout_count: { aggs: ['count'], precision: 0, direction: 'neutral', unit: 'count' },
  workout_minutes: { aggs: ['sum'], precision: 0, direction: 'neutral', unit: 'minutes' },

  // Task 8: the ECG session's own averaged rate, written to samples via alsoTargets rather than
  // derived from sessions the way sleep/workout are - unlike those two, ecg is a real DATA_TYPES
  // metric (catalogue.ts's 'ecg' entry, target 'sessions'), so it needs an entry here for
  // rollUpDay to aggregate it at all. Episodic like weight/body_fat rather than continuous like
  // heart_rate, so 'last'/'mean' and 'neutral': a single measured session's rate is not read as
  // simply healthier when lower, the same reasoning as weight's own 'neutral'.
  ecg_heart_rate: { aggs: ['last', 'mean'], precision: 0, direction: 'neutral', unit: 'bpm' },
}

/**
 * The sleep family, in one place so deriveSleepDay and the truth test cannot drift apart on
 * which metrics exist.
 *
 * That is a claim about a guarantee, so it names the thing that provides it: sleep-derive.test.ts
 * asserts equality between this list and what deriveSleepDay emits for a night reaching every
 * branch. Until M2f the claim stood on nothing, because deriveSleepDay pushes literal strings and
 * never reads this list, so either side could gain a metric alone and leave the suite green.
 */
export const SLEEP_METRICS = [
  'sleep_asleep_minutes', 'sleep_awake_minutes', 'sleep_in_bed_minutes',
  'sleep_deep_minutes', 'sleep_light_minutes', 'sleep_rem_minutes',
  'sleep_efficiency', 'sleep_bedtime_minutes', 'sleep_waketime_minutes',
  'sleep_nap_count', 'sleep_nap_minutes',
] as const

export function metricSpec(metric: string): MetricSpec | undefined {
  return METRICS[metric]
}
