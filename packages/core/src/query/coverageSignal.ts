import { DATA_TYPES } from '../api/catalogue.ts'

// Built once. The catalogue is a module constant, so the set cannot go stale.
const CONTINUOUSLY_SAMPLED = new Set(
  DATA_TYPES.filter((type) => type.tier === 'intraday').map((type) => type.metric),
)

/**
 * Whether a metric's coverage is a statement about data quality.
 *
 * Coverage is the fraction of the day's hours carrying at least one sample, which is comparable
 * within a metric and meaningless across metrics. A resting heart rate arrives once a day, so a
 * perfect one reads 1/24; a heart rate at 1/24 is a watch worn for an hour. Judging both against
 * one number reads the second's failure into the first's normal, which is why the question is
 * asked per metric rather than answered by a single threshold.
 *
 * Only a continuously sampled type can be judged this way, so only an intraday tier says true.
 * A metric no data type declares, which is every sleep metric, says false: its coverage is not
 * a weaker signal, it is not a signal.
 */
export function coverageIsMeaningful(metric: string): boolean {
  return CONTINUOUSLY_SAMPLED.has(metric)
}
