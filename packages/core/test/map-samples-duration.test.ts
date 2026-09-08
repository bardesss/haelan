import { describe, expect, it } from 'vitest'
import { mapSamples } from '../src/api/mapSamples.ts'
import type { DataType } from '../src/api/catalogue.ts'

const ctx = { personId: 'p1', resolveSource: () => 'watch', rawPayloadId: 'raw1' }

// Stands in for a real catalogue entry like sedentary-period, which carries only an interval -
// no valuePath exists to read, so the row's value has to come from the interval itself.
const plainDuration: DataType = {
  id: 'test-duration',
  filterRoot: 'test_duration',
  payloadKey: 'testDuration',
  filterMember: 'interval.start_time',
  actions: ['list'],
  scope: 'test.scope',
  target: 'samples',
  metric: 'test_duration_minutes',
  agg: 'raw',
  unit: 'minutes',
  valuePath: '',
  downsampleToMinute: false,
  tier: 'intraday',
  durationMinutes: true,
}

// Stands in for a type whose interval also carries an enum dimension - the level goes into the
// metric name the same way active-minutes does, but the value is still the interval's own length.
const subDimensionDuration: DataType = {
  id: 'test-duration-with-kind',
  filterRoot: 'test_duration_with_kind',
  payloadKey: 'testDurationWithKind',
  filterMember: 'interval.start_time',
  actions: ['list'],
  scope: 'test.scope',
  target: 'samples',
  metric: 'test_duration_with_kind',
  agg: 'raw',
  unit: 'minutes',
  valuePath: '',
  downsampleToMinute: false,
  tier: 'intraday',
  subDimension: {
    keyPath: 'kind',
    valuePath: '',
    durationMinutes: true,
    metricByKey: {
      WALKING: 'test_duration_walking',
      RUNNING: 'test_duration_running',
    },
  },
}

describe('mapSamples with durationMinutes', () => {
  it('writes one row whose value is the interval\'s own duration, with no valuePath to read', () => {
    const body = JSON.stringify({
      dataPoints: [{
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        testDuration: {
          interval: {
            startTime: '2026-08-21T09:00:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-21T09:45:00Z', endUtcOffset: '7200s',
          },
        },
      }],
    })
    const rows = mapSamples({ dataType: plainDuration, body, ...ctx })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      metric: 'test_duration_minutes', value: 45,
      utcMs: Date.UTC(2026, 7, 21, 9, 0), agg: 'raw',
    })
  })

  it('picks the metric from the enum key while still valuing the row from the interval', () => {
    const body = JSON.stringify({
      dataPoints: [{
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        testDurationWithKind: {
          interval: {
            startTime: '2026-08-21T08:00:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-21T08:20:00Z', endUtcOffset: '7200s',
          },
          kind: 'WALKING',
        },
      }],
    })
    const rows = mapSamples({ dataType: subDimensionDuration, body, ...ctx })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ metric: 'test_duration_walking', value: 20 })
  })

  it('writes no row when the interval is unparseable, rather than a row with a null value', () => {
    const body = JSON.stringify({
      dataPoints: [{
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        testDuration: {
          interval: { startTime: '2026-08-21T09:00:00Z' }, // no endTime
        },
      }],
    })
    expect(mapSamples({ dataType: plainDuration, body, ...ctx })).toEqual([])
  })

  it('writes no row for an enum key the metricByKey map does not name, same as any other sub-dimension type', () => {
    const body = JSON.stringify({
      dataPoints: [{
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        testDurationWithKind: {
          interval: {
            startTime: '2026-08-21T08:00:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-21T08:20:00Z', endUtcOffset: '7200s',
          },
          kind: 'CYCLING',
        },
      }],
    })
    expect(mapSamples({ dataType: subDimensionDuration, body, ...ctx })).toEqual([])
  })
})
