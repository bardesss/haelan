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
  heart_rate: { aggs: ['min', 'mean', 'max', 'p50'], precision: 0, direction: 'down', unit: 'bpm' },
  hrv: { aggs: ['min', 'mean', 'max', 'count'], precision: 0, direction: 'up', unit: 'milliseconds' },
  spo2: { aggs: ['min', 'mean', 'max', 'count'], precision: 1, direction: 'up', unit: 'percent' },

  // Episodic. A weight is a reading, not a rate, so the day's figure is the last one taken.
  weight: { aggs: ['last', 'mean'], precision: 1, direction: 'neutral', unit: 'grams' },
  body_fat: { ...SPOT, unit: 'percent' },

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
  sleep_bedtime_minutes: { aggs: ['last'], precision: 0, direction: 'neutral', unit: 'minutes' },
  sleep_waketime_minutes: { aggs: ['last'], precision: 0, direction: 'neutral', unit: 'minutes' },
  sleep_nap_count: { aggs: ['count'], precision: 0, direction: 'neutral', unit: 'count' },
  sleep_nap_minutes: { aggs: ['sum'], precision: 0, direction: 'neutral', unit: 'minutes' },
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
