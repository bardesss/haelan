import { describe, expect, it } from 'vitest'
import {
  ACTIONS, DATA_TYPES, dataTypeById, horizonDaysFor, supports,
  INTRADAY_HORIZON_DAYS, USER_HORIZON_CHOICES,
} from '../src/api/catalogue.ts'

describe('data type catalogue', () => {
  it('declares every type the v1 pages need', () => {
    const ids = DATA_TYPES.map((t) => t.id)
    for (const required of [
      'steps', 'distance', 'active-minutes', 'active-energy-burned', 'exercise',
      'heart-rate', 'daily-resting-heart-rate', 'heart-rate-variability',
      'oxygen-saturation', 'daily-respiratory-rate', 'sleep', 'weight', 'body-fat',
    ]) expect(ids, required).toContain(required)
  })

  it('uses kebab in the path and snake in the filter, because the API does', () => {
    for (const t of DATA_TYPES) {
      expect(t.id, t.id).not.toMatch(/_/)
      expect(t.filterRoot, t.id).toBe(t.id.replaceAll('-', '_'))
    }
  })

  it('gives the payload key in camel, which is neither of the other two', () => {
    const hr = dataTypeById('heart-rate')
    expect(hr?.payloadKey).toBe('heartRate')
    expect(dataTypeById('daily-resting-heart-rate')?.payloadKey).toBe('dailyRestingHeartRate')
  })

  it('records the filter member measured against the live API, not a guess', () => {
    expect(dataTypeById('steps')?.filterMember).toBe('interval.start_time')
    expect(dataTypeById('heart-rate')?.filterMember).toBe('sample_time.physical_time')
    expect(dataTypeById('daily-resting-heart-rate')?.filterMember).toBe('date')
    expect(dataTypeById('sleep')?.filterMember).toBe('interval.end_time')
    expect(dataTypeById('exercise')?.filterMember).toBe('interval.civil_start_time')
  })

  it('records a set of actions, because list and rollUp are neither opposites nor a partition', () => {
    // Measured in probe/findings/rollup-methods.md: steps answers both, sleep answers neither
    // rollup, floors answers reconcile as well. A boolean cannot say any of that.
    expect(supports(dataTypeById('steps')!, 'list')).toBe(true)
    expect(supports(dataTypeById('steps')!, 'dailyRollUp')).toBe(true)
    expect(supports(dataTypeById('sleep')!, 'list')).toBe(true)
    expect(supports(dataTypeById('sleep')!, 'dailyRollUp')).toBe(false)
    expect(supports(dataTypeById('total-calories')!, 'list')).toBe(false)
    expect(supports(dataTypeById('total-calories')!, 'dailyRollUp')).toBe(true)
    expect(supports(dataTypeById('floors')!, 'reconcile')).toBe(true)
  })

  it('gives every type at least one action it can actually be read with', () => {
    for (const t of DATA_TYPES) {
      expect(t.actions.length, t.id).toBeGreaterThan(0)
      for (const action of t.actions) expect(ACTIONS).toContain(action)
    }
  })

  it('gives every listable type a metric and a target', () => {
    for (const t of DATA_TYPES.filter((t) => supports(t, 'list'))) {
      expect(t.metric, t.id).toBeTruthy()
      expect(['samples', 'sessions'], t.id).toContain(t.target)
    }
  })

  it('declares a scope for every type, so a missing grant is a known cause', () => {
    for (const t of DATA_TYPES) expect(t.scope, t.id).toMatch(/^googlehealth\./)
  })

  it('has no duplicate ids', () => {
    expect(new Set(DATA_TYPES.map((t) => t.id)).size).toBe(DATA_TYPES.length)
  })

  it('points hrv value paths at the field the API actually returns', () => {
    expect(dataTypeById('heart-rate-variability')?.valuePath).toBe('rootMeanSquareOfSuccessiveDifferencesMilliseconds')
    expect(dataTypeById('daily-heart-rate-variability')?.valuePath).toBe('averageHeartRateVariabilityMilliseconds')
  })

  it('keeps every mapping-deferred type listable, since it is still fetched and archived', () => {
    for (const t of DATA_TYPES.filter((t) => t.mappingDeferred)) {
      expect(supports(t, 'list'), t.id).toBe(true)
    }
  })

  it('never defers mapping for a session target, which would be meaningless', () => {
    for (const t of DATA_TYPES.filter((t) => t.mappingDeferred)) {
      expect(t.target, t.id).not.toBe('sessions')
    }
  })

  it('declares every type raw, because agg records what we did, not what M2 should do', () => {
    for (const t of DATA_TYPES) expect(t.agg, t.id).toBe('raw')
  })

  it('leaves the downsample triple to the downsampler, so no entry claims an aggregate it never writes', () => {
    for (const t of DATA_TYPES) expect(['min', 'mean', 'max'], t.id).not.toContain(t.agg)
  })
})

describe('backfill horizons', () => {
  it('gives every type a horizon, so the backfill never has to invent one', () => {
    for (const type of DATA_TYPES) {
      for (const days of USER_HORIZON_CHOICES) {
        const horizon = horizonDaysFor(type, days)
        expect(horizon, type.id).toBeGreaterThan(0)
        expect(Number.isInteger(horizon), type.id).toBe(true)
      }
    }
  })

  it('keeps heart rate far shorter than a sparse daily type, because M0 measured why', () => {
    // 37,370 rows and 23 MB of raw JSON per person-day, 95 percent of all rows. Every other
    // type together is under 0.8M rows per person-year. See probe/findings/volume.md.
    //
    // heart-rate no longer compares against steps here: steps turned out to be one of the
    // dense intraday types too (see 'horizon tiers' above) and now shares heart rate's cap, so
    // the two are equal rather than heart rate being shorter. weight is still a genuine daily
    // type, so the comparison against it still demonstrates the cap doing its job.
    expect(horizonDaysFor(dataTypeById('heart-rate')!, 1825))
      .toBeLessThan(horizonDaysFor(dataTypeById('weight')!, 1825))
  })

  it('gives the sparse types years rather than weeks', () => {
    for (const id of ['weight', 'sleep', 'daily-resting-heart-rate']) {
      for (const days of USER_HORIZON_CHOICES) {
        expect(horizonDaysFor(dataTypeById(id)!, days), id).toBeGreaterThanOrEqual(365)
      }
    }
  })
})

describe('horizon tiers', () => {
  it('caps every intraday type at the intraday horizon whatever the operator chose', () => {
    for (const days of USER_HORIZON_CHOICES) {
      for (const type of DATA_TYPES.filter((t) => t.tier === 'intraday')) {
        expect(horizonDaysFor(type, days)).toBe(INTRADAY_HORIZON_DAYS)
      }
    }
  })

  it('gives every daily type exactly what the operator chose', () => {
    for (const days of USER_HORIZON_CHOICES) {
      for (const type of DATA_TYPES.filter((t) => t.tier === 'daily')) {
        expect(horizonDaysFor(type, days)).toBe(days)
      }
    }
  })

  // The measurement this whole change exists for: active-energy-burned is intraday at 932 rows
  // a day and was inheriting the 1825-day default, which is 56 percent of a 1.35 GB projection.
  it('classifies the dense types that were costing the most, not only heart rate', () => {
    const intraday = DATA_TYPES.filter((t) => t.tier === 'intraday').map((t) => t.id).sort()
    expect(intraday).toEqual([
      'active-energy-burned', 'active-minutes', 'active-zone-minutes', 'distance',
      'heart-rate', 'heart-rate-variability', 'oxygen-saturation', 'steps',
    ])
  })

  it('offers one year, two years and five years, defaulting to two', () => {
    expect(USER_HORIZON_CHOICES).toEqual([365, 730, 1825])
    expect(USER_HORIZON_CHOICES).toContain(730)
  })

  it('gives every data type a tier', () => {
    for (const type of DATA_TYPES) expect(['intraday', 'daily']).toContain(type.tier)
  })
})
