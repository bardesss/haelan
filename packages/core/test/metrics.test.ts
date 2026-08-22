import { describe, expect, it } from 'vitest'
import { DATA_TYPES } from '../src/api/catalogue.ts'
import { METRICS, DAILY_AGGS, metricSpec } from '../src/derive/metrics.ts'

describe('the metric catalogue', () => {
  // The failure this prevents: a metric added to the data type catalogue and forgotten here
  // rolls up to nothing at all, silently, because rollUpDay has no aggregates to compute.
  it('declares every sample metric the data type catalogue names', () => {
    const sampleMetrics = DATA_TYPES.filter((t) => t.target === 'samples').map((t) => t.metric)
    for (const metric of sampleMetrics) {
      expect(METRICS[metric], `no METRICS entry for ${metric}`).toBeDefined()
    }
  })

  // Session metrics are M2c's: their daily figures come from sessions and segments, not from
  // samples, so an entry here would claim a rollup that rollUpDay cannot produce.
  it('declares no session metric, because those are derived from sessions', () => {
    const sessionMetrics = DATA_TYPES.filter((t) => t.target === 'sessions').map((t) => t.metric)
    for (const metric of sessionMetrics) {
      expect(METRICS[metric], `unexpected METRICS entry for ${metric}`).toBeUndefined()
    }
  })

  it('draws every aggregate from the fixed set', () => {
    for (const [metric, spec] of Object.entries(METRICS)) {
      expect(spec.aggs.length, `${metric} declares no aggregate`).toBeGreaterThan(0)
      for (const agg of spec.aggs) expect(DAILY_AGGS).toContain(agg)
    }
  })

  it('never sums a metric whose sum is meaningless', () => {
    // Summing heart rate across a day is not a number anyone means. Averaging steps is not
    // what anyone means by steps either, but that direction is caught by reading the table.
    for (const metric of ['heart_rate', 'hrv', 'spo2', 'weight', 'body_fat', 'resting_heart_rate']) {
      expect(METRICS[metric]?.aggs, metric).not.toContain('sum')
    }
  })

  it('answers by name and says so when it does not know', () => {
    expect(metricSpec('steps')?.aggs).toContain('sum')
    expect(metricSpec('not_a_metric')).toBeUndefined()
  })
})
