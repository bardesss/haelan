import { describe, expect, it } from 'vitest'
import { dataTypeById } from '../src/api/catalogue.ts'
import { mapSamples } from '../src/api/mapSamples.ts'
import { samplePoint, intervalPoint, dailyPoint, body } from '../src/testing/payloads.ts'

// Group F: six data types named by neither the release notes nor the drift check - it sees only
// rollup-capable types named in prose. Measured 2026-09-06; see
// .superpowers/sdd/2026-09-06-catalogue-catches-up/api-schemas.md and task-11-brief.md's own
// measured table (payloadKey, clock, value, unit) for the five ordinary scalars, and the brief's
// prose for daily-heart-rate-zones' sub-dimension.

const ctx = { personId: 'p1', resolveSource: () => 's1', rawPayloadId: 'r1' }

const METRICS_SCOPE = 'googlehealth.health_metrics_and_measurements.readonly'
const ACTIVITY_SCOPE = 'googlehealth.activity_and_fitness.readonly'
const SLEEP_SCOPE = 'googlehealth.sleep.readonly'

describe('the catalogue declares Group F', () => {
  it('declares vo2-max, an instant reading distinct from run-vo2-max', () => {
    const dt = dataTypeById('vo2-max')!
    expect({
      id: dt.id, payloadKey: dt.payloadKey, filterMember: dt.filterMember, scope: dt.scope,
      metric: dt.metric, target: dt.target, unit: dt.unit, valuePath: dt.valuePath,
    }).toEqual({
      id: 'vo2-max', payloadKey: 'vo2Max', filterMember: 'sample_time.physical_time',
      scope: METRICS_SCOPE, metric: 'vo2_max', target: 'samples',
      unit: 'ml_kg_min', valuePath: 'vo2Max',
    })
    // The whole reason this type needs its own name: it must not collide with run-vo2-max's.
    expect(dt.metric).not.toBe(dataTypeById('run-vo2-max')!.metric)
  })

  it('declares daily-vo2-max, a civil-date summary distinct from both other VO2 max types', () => {
    const dt = dataTypeById('daily-vo2-max')!
    expect({
      id: dt.id, payloadKey: dt.payloadKey, filterMember: dt.filterMember, scope: dt.scope,
      metric: dt.metric, target: dt.target, unit: dt.unit, valuePath: dt.valuePath,
    }).toEqual({
      id: 'daily-vo2-max', payloadKey: 'dailyVo2Max', filterMember: 'date',
      scope: METRICS_SCOPE, metric: 'daily_vo2_max', target: 'samples',
      unit: 'ml_kg_min', valuePath: 'vo2Max',
    })
    expect(dt.metric).not.toBe(dataTypeById('run-vo2-max')!.metric)
    expect(dt.metric).not.toBe(dataTypeById('vo2-max')!.metric)
  })

  it('declares basal-energy-burned, an interval reading attributed to the interval start', () => {
    const dt = dataTypeById('basal-energy-burned')!
    expect({
      id: dt.id, payloadKey: dt.payloadKey, filterMember: dt.filterMember, scope: dt.scope,
      metric: dt.metric, target: dt.target, unit: dt.unit, valuePath: dt.valuePath,
    }).toEqual({
      id: 'basal-energy-burned', payloadKey: 'basalEnergyBurned', filterMember: 'interval.start_time',
      scope: ACTIVITY_SCOPE, metric: 'basal_energy', target: 'samples',
      unit: 'kcal', valuePath: 'kcal',
    })
  })

  it('declares daily-sleep-temperature-derivations, mapping the whole-night figure only', () => {
    const dt = dataTypeById('daily-sleep-temperature-derivations')!
    expect({
      id: dt.id, payloadKey: dt.payloadKey, filterMember: dt.filterMember, scope: dt.scope,
      metric: dt.metric, target: dt.target, unit: dt.unit, valuePath: dt.valuePath,
    }).toEqual({
      id: 'daily-sleep-temperature-derivations', payloadKey: 'dailySleepTemperatureDerivations',
      filterMember: 'date', scope: SLEEP_SCOPE, metric: 'sleep_temperature', target: 'samples',
      unit: 'celsius', valuePath: 'nightlyTemperatureCelsius',
    })
  })

  it('declares respiratory-rate-sleep-summary, mapping the whole-night figure only', () => {
    const dt = dataTypeById('respiratory-rate-sleep-summary')!
    expect({
      id: dt.id, payloadKey: dt.payloadKey, filterMember: dt.filterMember, scope: dt.scope,
      metric: dt.metric, target: dt.target, unit: dt.unit, valuePath: dt.valuePath,
    }).toEqual({
      id: 'respiratory-rate-sleep-summary', payloadKey: 'respiratoryRateSleepSummary',
      filterMember: 'sample_time.physical_time', scope: SLEEP_SCOPE, metric: 'sleep_respiratory_rate',
      target: 'samples', unit: 'breaths_per_minute', valuePath: 'fullSleepStats.breathsPerMinute',
    })
    expect(dt.metric).not.toBe(dataTypeById('daily-respiratory-rate')!.metric)
  })

  it('declares daily-heart-rate-zones: a threshold split by heartRateZoneType, ceiling only', () => {
    const dt = dataTypeById('daily-heart-rate-zones')!
    expect({
      id: dt.id, payloadKey: dt.payloadKey, filterMember: dt.filterMember, scope: dt.scope,
      metric: dt.metric, target: dt.target, unit: dt.unit, valuePath: dt.valuePath,
      subDimension: dt.subDimension,
    }).toEqual({
      id: 'daily-heart-rate-zones', payloadKey: 'dailyHeartRateZones', filterMember: 'date',
      scope: ACTIVITY_SCOPE, metric: 'daily_heart_rate_zones', target: 'samples',
      unit: 'bpm', valuePath: '',
      subDimension: {
        arrayPath: 'heartRateZones', keyPath: 'heartRateZoneType', valuePath: 'maxBeatsPerMinute',
        durationMinutes: undefined,
        metricByKey: {
          LIGHT: 'heart_rate_zone_light_max_bpm',
          MODERATE: 'heart_rate_zone_moderate_max_bpm',
          VIGOROUS: 'heart_rate_zone_vigorous_max_bpm',
          PEAK: 'heart_rate_zone_peak_max_bpm',
        },
      },
    })
  })
})

describe('vo2-max', () => {
  it('maps a general VO2 max reading', () => {
    const dt = dataTypeById('vo2-max')!
    const rows = mapSamples({
      dataType: dt, ...ctx,
      body: body([samplePoint({
        payloadKey: 'vo2Max', valuePath: 'vo2Max', value: 44.2,
        physicalTime: '2026-08-18T08:00:00Z',
      })]),
    })
    expect(rows).toEqual([{
      personId: 'p1', sourceId: 's1', metric: dt.metric, utcMs: Date.UTC(2026, 7, 18, 8, 0),
      tzOffsetMinutes: 120, agg: 'raw', value: 44.2, n: 1, rawPayloadId: 'r1',
    }])
  })

  it('writes no row when vo2Max is absent', () => {
    const dt = dataTypeById('vo2-max')!
    const rows = mapSamples({
      dataType: dt, ...ctx,
      body: body([{ dataSource: {}, vo2Max: { sampleTime: { physicalTime: '2026-08-18T08:00:00Z', utcOffset: '7200s' } } }]),
    })
    expect(rows).toEqual([])
  })
})

describe('daily-vo2-max', () => {
  it('maps a daily VO2 max summary', () => {
    const dt = dataTypeById('daily-vo2-max')!
    const rows = mapSamples({
      dataType: dt, ...ctx,
      body: body([dailyPoint({
        payloadKey: 'dailyVo2Max', valuePath: 'vo2Max', value: 45.6,
        date: { year: 2026, month: 8, day: 18 },
      })]),
    })
    expect(rows).toEqual([{
      personId: 'p1', sourceId: 's1', metric: dt.metric, utcMs: Date.UTC(2026, 7, 18, 0, 0),
      tzOffsetMinutes: 0, agg: 'raw', value: 45.6, n: 1, rawPayloadId: 'r1',
    }])
  })

  it('writes no row when vo2Max is absent', () => {
    const dt = dataTypeById('daily-vo2-max')!
    const rows = mapSamples({
      dataType: dt, ...ctx,
      body: body([{ dataSource: {}, dailyVo2Max: { date: { year: 2026, month: 8, day: 18 } } }]),
    })
    expect(rows).toEqual([])
  })
})

describe('basal-energy-burned', () => {
  it('maps a basal energy reading at its interval start', () => {
    const dt = dataTypeById('basal-energy-burned')!
    const rows = mapSamples({
      dataType: dt, ...ctx,
      body: body([intervalPoint({
        payloadKey: 'basalEnergyBurned', valuePath: 'kcal', value: 62,
        physicalTime: '2026-08-18T08:00:00Z', endTime: '2026-08-18T09:00:00Z',
      })]),
    })
    expect(rows).toEqual([{
      personId: 'p1', sourceId: 's1', metric: dt.metric, utcMs: Date.UTC(2026, 7, 18, 8, 0),
      tzOffsetMinutes: 120, agg: 'raw', value: 62, n: 1, rawPayloadId: 'r1',
    }])
  })

  it('writes no row when kcal is absent', () => {
    const dt = dataTypeById('basal-energy-burned')!
    const rows = mapSamples({
      dataType: dt, ...ctx,
      body: body([{
        dataSource: {},
        basalEnergyBurned: {
          interval: {
            startTime: '2026-08-18T08:00:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-18T09:00:00Z', endUtcOffset: '7200s',
          },
        },
      }]),
    })
    expect(rows).toEqual([])
  })
})

describe('daily-sleep-temperature-derivations', () => {
  it('maps the nightly temperature figure', () => {
    const dt = dataTypeById('daily-sleep-temperature-derivations')!
    const rows = mapSamples({
      dataType: dt, ...ctx,
      body: body([dailyPoint({
        payloadKey: 'dailySleepTemperatureDerivations', valuePath: 'nightlyTemperatureCelsius',
        value: 36.4, date: { year: 2026, month: 8, day: 18 },
      })]),
    })
    expect(rows).toEqual([{
      personId: 'p1', sourceId: 's1', metric: dt.metric, utcMs: Date.UTC(2026, 7, 18, 0, 0),
      tzOffsetMinutes: 0, agg: 'raw', value: 36.4, n: 1, rawPayloadId: 'r1',
    }])
  })

  // The archived fields are present but nightlyTemperatureCelsius is not - proof the mapper
  // reads only the one field this type declares, not either of its two neighbours.
  it('writes no row when nightlyTemperatureCelsius is absent, even though the archived fields are present', () => {
    const dt = dataTypeById('daily-sleep-temperature-derivations')!
    const rows = mapSamples({
      dataType: dt, ...ctx,
      body: body([{
        dataSource: {},
        dailySleepTemperatureDerivations: {
          date: { year: 2026, month: 8, day: 18 },
          baselineTemperatureCelsius: 36.6,
          relativeNightlyStddev30dCelsius: 0.3,
        },
      }]),
    })
    expect(rows).toEqual([])
  })
})

describe('respiratory-rate-sleep-summary', () => {
  it('maps the whole-night breathsPerMinute figure', () => {
    const dt = dataTypeById('respiratory-rate-sleep-summary')!
    const rows = mapSamples({
      dataType: dt, ...ctx,
      body: body([samplePoint({
        payloadKey: 'respiratoryRateSleepSummary', valuePath: 'fullSleepStats.breathsPerMinute',
        value: 14.5, physicalTime: '2026-08-18T08:00:00Z',
      })]),
    })
    expect(rows).toEqual([{
      personId: 'p1', sourceId: 's1', metric: dt.metric, utcMs: Date.UTC(2026, 7, 18, 8, 0),
      tzOffsetMinutes: 120, agg: 'raw', value: 14.5, n: 1, rawPayloadId: 'r1',
    }])
  })

  // remSleepStats, deepSleepStats and lightSleepStats are present but fullSleepStats is not -
  // proof the mapper reads only the whole-night stat block, not one of the three archived ones.
  it('writes no row when fullSleepStats is absent, even though the archived stage blocks are present', () => {
    const dt = dataTypeById('respiratory-rate-sleep-summary')!
    const rows = mapSamples({
      dataType: dt, ...ctx,
      body: body([{
        dataSource: {},
        respiratoryRateSleepSummary: {
          sampleTime: { physicalTime: '2026-08-18T08:00:00Z', utcOffset: '7200s' },
          remSleepStats: { breathsPerMinute: 15.1 },
          deepSleepStats: { breathsPerMinute: 13.9 },
          lightSleepStats: { breathsPerMinute: 14.7 },
        },
      }]),
    })
    expect(rows).toEqual([])
  })
})

describe('daily-heart-rate-zones', () => {
  // minBeatsPerMinute and maxBeatsPerMinute are declared `string` in the schema - this is what
  // the API actually sends, not a fixture convenience.
  const zonePoint = (zones: Array<{ heartRateZoneType: string, minBeatsPerMinute: string, maxBeatsPerMinute: string }>) => ({
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    dailyHeartRateZones: {
      date: { year: 2026, month: 8, day: 18 },
      heartRateZones: zones,
    },
  })

  it('gives each named zone its own metric, valued by maxBeatsPerMinute as a parsed string', () => {
    const dt = dataTypeById('daily-heart-rate-zones')!
    const body_ = body([zonePoint([
      { heartRateZoneType: 'LIGHT', minBeatsPerMinute: '91', maxBeatsPerMinute: '110' },
      { heartRateZoneType: 'MODERATE', minBeatsPerMinute: '110', maxBeatsPerMinute: '129' },
      { heartRateZoneType: 'VIGOROUS', minBeatsPerMinute: '129', maxBeatsPerMinute: '155' },
      { heartRateZoneType: 'PEAK', minBeatsPerMinute: '155', maxBeatsPerMinute: '190' },
    ])])
    const rows = mapSamples({ dataType: dt, ...ctx, body: body_ })
    expect(rows.map((r) => [r.metric, r.value])).toEqual([
      ['heart_rate_zone_light_max_bpm', 110],
      ['heart_rate_zone_moderate_max_bpm', 129],
      ['heart_rate_zone_vigorous_max_bpm', 155],
      ['heart_rate_zone_peak_max_bpm', 190],
    ])
  })

  it('writes one row per named zone, not one per data point, for a single point carrying all four', () => {
    const dt = dataTypeById('daily-heart-rate-zones')!
    const body_ = body([zonePoint([
      { heartRateZoneType: 'LIGHT', minBeatsPerMinute: '91', maxBeatsPerMinute: '110' },
      { heartRateZoneType: 'MODERATE', minBeatsPerMinute: '110', maxBeatsPerMinute: '129' },
      { heartRateZoneType: 'VIGOROUS', minBeatsPerMinute: '129', maxBeatsPerMinute: '155' },
      { heartRateZoneType: 'PEAK', minBeatsPerMinute: '155', maxBeatsPerMinute: '190' },
    ])])
    const rows = mapSamples({ dataType: dt, ...ctx, body: body_ })
    expect(rows).toHaveLength(4)
  })

  it('writes no row for HEART_RATE_ZONE_TYPE_UNSPECIFIED, which is not a zone', () => {
    const dt = dataTypeById('daily-heart-rate-zones')!
    const body_ = body([zonePoint([
      { heartRateZoneType: 'HEART_RATE_ZONE_TYPE_UNSPECIFIED', minBeatsPerMinute: '0', maxBeatsPerMinute: '91' },
    ])])
    expect(mapSamples({ dataType: dt, ...ctx, body: body_ })).toEqual([])
  })

  it('writes no row for a zone the field map never recorded', () => {
    const dt = dataTypeById('daily-heart-rate-zones')!
    const body_ = body([zonePoint([
      { heartRateZoneType: 'SOMETHING_NEW', minBeatsPerMinute: '10', maxBeatsPerMinute: '20' },
    ])])
    expect(mapSamples({ dataType: dt, ...ctx, body: body_ })).toEqual([])
  })
})
