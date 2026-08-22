// What DATA_TYPES is to Google, this is to the dashboard. DATA_TYPES describes what the API
// offers and how to fetch it; this describes what a metric means once it is ours. They change
// for different reasons and on different clocks, which is why they are two modules.
//
// Unit stays on DATA_TYPES, where it already is: it is a property of what was fetched.

export const DAILY_AGGS = ['min', 'mean', 'max', 'last', 'sum', 'count', 'p50'] as const
export type DailyAgg = (typeof DAILY_AGGS)[number]

export interface MetricSpec {
  /** Which aggregates are meaningful. Summing heart rate is not a number anyone means. */
  aggs: readonly DailyAgg[]
  /** Decimals to show, in the unit DATA_TYPES declares. */
  precision: number
  /** Whether a higher reading is better, worse, or neither. Read by M3's baseline bands. */
  direction: 'up' | 'down' | 'neutral'
}

const TOTAL: MetricSpec = { aggs: ['sum'], precision: 0, direction: 'up' }
const SPOT: MetricSpec = { aggs: ['last', 'mean'], precision: 1, direction: 'neutral' }

export const METRICS: Record<string, MetricSpec> = {
  steps: TOTAL,
  distance: { aggs: ['sum'], precision: 0, direction: 'up' },
  active_energy: TOTAL,
  total_calories: TOTAL,
  floors: TOTAL,
  hydration: { aggs: ['sum'], precision: 0, direction: 'up' },
  nutrition: TOTAL,

  // One metric per activity level and per heart rate zone. The sub-dimension is in the name,
  // which is what lets each be an ordinary metric with an ordinary rollup. The six suffixes are
  // the enum values probe/findings/field-map.md records, measured rather than guessed.
  active_minutes_light: TOTAL,
  active_minutes_moderate: TOTAL,
  active_minutes_vigorous: TOTAL,
  active_zone_minutes_fat_burn: TOTAL,
  active_zone_minutes_cardio: TOTAL,
  active_zone_minutes_peak: TOTAL,

  // Renamed to the per level metrics above in task 10, when the mapper learns to split them.
  active_minutes: TOTAL,
  active_zone_minutes: TOTAL,

  // Intraday series: min, mean and max are three different readings of the same day and a card
  // shows all three. p50 is carried because a mean over a day with one glitching hour is not
  // the middle of anything.
  heart_rate: { aggs: ['min', 'mean', 'max', 'p50'], precision: 0, direction: 'down' },
  hrv: { aggs: ['min', 'mean', 'max'], precision: 0, direction: 'up' },
  spo2: { aggs: ['min', 'mean', 'max'], precision: 1, direction: 'up' },

  // Episodic. A weight is a reading, not a rate, so the day's figure is the last one taken.
  weight: { aggs: ['last', 'mean'], precision: 1, direction: 'neutral' },
  body_fat: SPOT,

  // One value a day from the API already. last is the whole story; mean would average one number.
  resting_heart_rate: { aggs: ['last'], precision: 0, direction: 'down' },
  daily_hrv: { aggs: ['last'], precision: 0, direction: 'up' },
  daily_spo2: { aggs: ['last'], precision: 1, direction: 'up' },
  respiratory_rate: { aggs: ['last'], precision: 1, direction: 'neutral' },
}

export function metricSpec(metric: string): MetricSpec | undefined {
  return METRICS[metric]
}
