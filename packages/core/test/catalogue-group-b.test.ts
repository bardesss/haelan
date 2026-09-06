import { describe, expect, it } from 'vitest'
import { dataTypeById } from '../src/api/catalogue.ts'
import { mapSamples } from '../src/api/mapSamples.ts'

const ctx = { personId: 'p1', resolveSource: () => 'watch', rawPayloadId: 'raw1' }

// Group B: sedentary-period, activity-level, time-in-heart-rate-zone and swim-lengths-data.
// All four carry an ObservationTimeInterval and nothing that shapeFor in catalogue-truth.test.ts
// could plant a value at, so their shapes are exercised here instead - the model for this is
// map-samples.test.ts's active-minutes and active-zone-minutes cases, and map-samples-duration.
// test.ts's synthetic duration types.

describe('the catalogue declares Group B', () => {
  it('declares sedentary-period, activity-level, time-in-heart-rate-zone and swim-lengths-data', () => {
    for (const id of ['sedentary-period', 'activity-level', 'time-in-heart-rate-zone', 'swim-lengths-data']) {
      expect(dataTypeById(id), id).toBeDefined()
    }
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
