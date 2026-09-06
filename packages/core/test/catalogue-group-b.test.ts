import { describe, expect, it } from 'vitest'
import { dataTypeById } from '../src/api/catalogue.ts'
import { mapSamples } from '../src/api/mapSamples.ts'

const ctx = { personId: 'p1', resolveSource: () => 'watch', rawPayloadId: 'raw1' }

// Group B: sedentary-period, activity-level, time-in-heart-rate-zone and swim-lengths-data.
// All four carry an ObservationTimeInterval and nothing that shapeFor in catalogue-truth.test.ts
// could plant a value at, so their shapes are exercised here instead - the model for this is
// map-samples.test.ts's active-minutes and active-zone-minutes cases, and map-samples-duration.
// test.ts's synthetic duration types.

const ACTIVITY_SCOPE = 'googlehealth.activity_and_fitness.readonly'

// Pins each entry's shape field by field rather than a whole-object toEqual, because DataType
// carries other fields (actions, agg, tier, downsampleToMinute, filterRoot, ...) this test has no
// opinion about. The point of naming durationMinutes and valuePath explicitly, including inside
// subDimension, is the asymmetry described below: three of the four are pure durations with an
// empty leaf, and swim-lengths-data is the one with a real value and no duration.
describe('the catalogue declares Group B', () => {
  it('declares sedentary-period: a plain duration type, no subDimension', () => {
    const dt = dataTypeById('sedentary-period')!
    expect({
      id: dt.id, payloadKey: dt.payloadKey, filterMember: dt.filterMember, scope: dt.scope,
      metric: dt.metric, target: dt.target, unit: dt.unit, valuePath: dt.valuePath,
      durationMinutes: dt.durationMinutes, subDimension: dt.subDimension,
    }).toEqual({
      id: 'sedentary-period', payloadKey: 'sedentaryPeriod', filterMember: 'interval.start_time',
      scope: ACTIVITY_SCOPE, metric: 'sedentary_minutes', target: 'samples', unit: 'minutes',
      valuePath: '', durationMinutes: true, subDimension: undefined,
    })
  })

  it('declares activity-level: a duration split by activityLevelType, empty leaf per level', () => {
    const dt = dataTypeById('activity-level')!
    expect({
      id: dt.id, payloadKey: dt.payloadKey, filterMember: dt.filterMember, scope: dt.scope,
      metric: dt.metric, target: dt.target, unit: dt.unit, valuePath: dt.valuePath,
      durationMinutes: dt.durationMinutes, subDimension: dt.subDimension,
    }).toEqual({
      id: 'activity-level', payloadKey: 'activityLevel', filterMember: 'interval.start_time',
      scope: ACTIVITY_SCOPE, metric: 'activity_level', target: 'samples', unit: 'minutes',
      valuePath: '', durationMinutes: undefined,
      subDimension: {
        keyPath: 'activityLevelType', valuePath: '', durationMinutes: true,
        metricByKey: {
          SEDENTARY: 'activity_level_sedentary_minutes',
          LIGHTLY_ACTIVE: 'activity_level_lightly_active_minutes',
          MODERATELY_ACTIVE: 'activity_level_moderately_active_minutes',
          VERY_ACTIVE: 'activity_level_very_active_minutes',
        },
      },
    })
  })

  it('declares time-in-heart-rate-zone: a duration split by heartRateZoneType, empty leaf per zone', () => {
    const dt = dataTypeById('time-in-heart-rate-zone')!
    expect({
      id: dt.id, payloadKey: dt.payloadKey, filterMember: dt.filterMember, scope: dt.scope,
      metric: dt.metric, target: dt.target, unit: dt.unit, valuePath: dt.valuePath,
      durationMinutes: dt.durationMinutes, subDimension: dt.subDimension,
    }).toEqual({
      id: 'time-in-heart-rate-zone', payloadKey: 'timeInHeartRateZone', filterMember: 'interval.start_time',
      scope: ACTIVITY_SCOPE, metric: 'time_in_heart_rate_zone', target: 'samples', unit: 'minutes',
      valuePath: '', durationMinutes: undefined,
      subDimension: {
        keyPath: 'heartRateZoneType', valuePath: '', durationMinutes: true,
        metricByKey: {
          LIGHT: 'time_in_heart_rate_zone_light_minutes',
          MODERATE: 'time_in_heart_rate_zone_moderate_minutes',
          VIGOROUS: 'time_in_heart_rate_zone_vigorous_minutes',
          PEAK: 'time_in_heart_rate_zone_peak_minutes',
        },
      },
    })
  })

  it('declares swim-lengths-data: a count split by swimStrokeType, real valuePath and no duration', () => {
    const dt = dataTypeById('swim-lengths-data')!
    expect({
      id: dt.id, payloadKey: dt.payloadKey, filterMember: dt.filterMember, scope: dt.scope,
      metric: dt.metric, target: dt.target, unit: dt.unit, valuePath: dt.valuePath,
      durationMinutes: dt.durationMinutes, subDimension: dt.subDimension,
    }).toEqual({
      id: 'swim-lengths-data', payloadKey: 'swimLengthsData', filterMember: 'interval.start_time',
      scope: ACTIVITY_SCOPE, metric: 'swim_lengths', target: 'samples', unit: 'count',
      valuePath: '', durationMinutes: undefined,
      subDimension: {
        keyPath: 'swimStrokeType', valuePath: 'strokeCount', durationMinutes: undefined,
        metricByKey: {
          FREESTYLE: 'swim_lengths_freestyle_strokes',
          BACKSTROKE: 'swim_lengths_backstroke_strokes',
          BREASTSTROKE: 'swim_lengths_breaststroke_strokes',
          BUTTERFLY: 'swim_lengths_butterfly_strokes',
        },
      },
    })
  })
})

describe('sedentary-period', () => {
  it('maps a single duration metric from the interval, with no valuePath to read', () => {
    const body = JSON.stringify({
      dataPoints: [{
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        sedentaryPeriod: {
          interval: {
            startTime: '2026-08-21T09:00:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-21T09:45:00Z', endUtcOffset: '7200s',
          },
        },
      }],
    })
    const rows = mapSamples({ dataType: dataTypeById('sedentary-period')!, body, ...ctx })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      personId: 'p1', sourceId: 'watch', metric: 'sedentary_minutes',
      utcMs: Date.UTC(2026, 7, 21, 9, 0), tzOffsetMinutes: 120,
      agg: 'raw', value: 45, n: 1, rawPayloadId: 'raw1',
    })
  })
})

describe('activity-level', () => {
  const point = (activityLevelType: string) => ({
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    activityLevel: {
      interval: {
        startTime: '2026-08-21T08:00:00Z', startUtcOffset: '7200s',
        endTime: '2026-08-21T08:30:00Z', endUtcOffset: '7200s',
      },
      activityLevelType,
    },
  })

  it('gives each named level its own metric, valued by the interval, not a leaf', () => {
    const body = JSON.stringify({
      dataPoints: [
        point('SEDENTARY'), point('LIGHTLY_ACTIVE'), point('MODERATELY_ACTIVE'), point('VERY_ACTIVE'),
      ],
    })
    const rows = mapSamples({ dataType: dataTypeById('activity-level')!, body, ...ctx })
    expect(rows.map((r) => [r.metric, r.value])).toEqual([
      ['activity_level_sedentary_minutes', 30],
      ['activity_level_lightly_active_minutes', 30],
      ['activity_level_moderately_active_minutes', 30],
      ['activity_level_very_active_minutes', 30],
    ])
  })

  it('writes no row for ACTIVITY_LEVEL_TYPE_UNSPECIFIED, which is not a level', () => {
    const body = JSON.stringify({ dataPoints: [point('ACTIVITY_LEVEL_TYPE_UNSPECIFIED')] })
    expect(mapSamples({ dataType: dataTypeById('activity-level')!, body, ...ctx })).toEqual([])
  })

  it('writes no row for a level the field map never recorded', () => {
    const body = JSON.stringify({ dataPoints: [point('SOMETHING_NEW')] })
    expect(mapSamples({ dataType: dataTypeById('activity-level')!, body, ...ctx })).toEqual([])
  })
})

describe('time-in-heart-rate-zone', () => {
  const point = (heartRateZoneType: string) => ({
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    timeInHeartRateZone: {
      interval: {
        startTime: '2026-08-21T08:00:00Z', startUtcOffset: '7200s',
        endTime: '2026-08-21T08:10:00Z', endUtcOffset: '7200s',
      },
      heartRateZoneType,
    },
  })

  it('gives each named zone its own metric, valued by the interval', () => {
    const body = JSON.stringify({
      dataPoints: [point('LIGHT'), point('MODERATE'), point('VIGOROUS'), point('PEAK')],
    })
    const rows = mapSamples({ dataType: dataTypeById('time-in-heart-rate-zone')!, body, ...ctx })
    expect(rows.map((r) => [r.metric, r.value])).toEqual([
      ['time_in_heart_rate_zone_light_minutes', 10],
      ['time_in_heart_rate_zone_moderate_minutes', 10],
      ['time_in_heart_rate_zone_vigorous_minutes', 10],
      ['time_in_heart_rate_zone_peak_minutes', 10],
    ])
  })

  it('writes no row for HEART_RATE_ZONE_TYPE_UNSPECIFIED, which is not a zone', () => {
    const body = JSON.stringify({ dataPoints: [point('HEART_RATE_ZONE_TYPE_UNSPECIFIED')] })
    expect(mapSamples({ dataType: dataTypeById('time-in-heart-rate-zone')!, body, ...ctx })).toEqual([])
  })

  it('writes no row for a zone the field map never recorded', () => {
    const body = JSON.stringify({ dataPoints: [point('SOMETHING_NEW')] })
    expect(mapSamples({ dataType: dataTypeById('time-in-heart-rate-zone')!, body, ...ctx })).toEqual([])
  })
})

describe('swim-lengths-data', () => {
  // strokeCount arrives as a JSON string (int64-as-string), exactly what the API sends - not a
  // number, which is what a careless fixture would reach for instead.
  const point = (swimStrokeType: string, strokeCount: string) => ({
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    swimLengthsData: {
      interval: {
        startTime: '2026-08-21T08:00:00Z', startUtcOffset: '7200s',
        endTime: '2026-08-21T08:20:00Z', endUtcOffset: '7200s',
      },
      swimStrokeType,
      strokeCount,
    },
  })

  it('gives each named stroke its own metric, valued from strokeCount, not the interval', () => {
    const body = JSON.stringify({
      dataPoints: [
        point('FREESTYLE', '40'), point('BACKSTROKE', '12'), point('BREASTSTROKE', '8'), point('BUTTERFLY', '4'),
      ],
    })
    const rows = mapSamples({ dataType: dataTypeById('swim-lengths-data')!, body, ...ctx })
    expect(rows.map((r) => [r.metric, r.value])).toEqual([
      ['swim_lengths_freestyle_strokes', 40],
      ['swim_lengths_backstroke_strokes', 12],
      ['swim_lengths_breaststroke_strokes', 8],
      ['swim_lengths_butterfly_strokes', 4],
    ])
  })

  it('writes no row for SWIM_STROKE_TYPE_UNSPECIFIED, which is not a stroke', () => {
    const body = JSON.stringify({ dataPoints: [point('SWIM_STROKE_TYPE_UNSPECIFIED', '5')] })
    expect(mapSamples({ dataType: dataTypeById('swim-lengths-data')!, body, ...ctx })).toEqual([])
  })

  it('writes no row for a stroke the field map never recorded', () => {
    const body = JSON.stringify({ dataPoints: [point('SOMETHING_NEW', '5')] })
    expect(mapSamples({ dataType: dataTypeById('swim-lengths-data')!, body, ...ctx })).toEqual([])
  })
})
