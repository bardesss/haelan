import { describe, expect, it } from 'vitest'
import { dataTypeById } from '../src/api/catalogue.ts'
import { mapSamples } from '../src/api/mapSamples.ts'
import { samplePoint, intervalPoint, body } from '../src/testing/payloads.ts'

// Shapes measured against the v4 discovery document, 2026-09-06 -
// .superpowers/sdd/2026-09-06-catalogue-catches-up/api-schemas.md. Height and Altitude declare
// their leaf as `string` (int64-as-string) rather than `number`, which is why each gets its own
// string-payload test below rather than sharing a fixture with the number-typed three.

const ctx = { personId: 'p1', resolveSource: () => 's1', rawPayloadId: 'r1' }

describe('catalogue group A: five scalars', () => {
  it('declares height, an instant reading in millimeters', () => {
    expect(dataTypeById('height')).toMatchObject({
      id: 'height', payloadKey: 'height', filterMember: 'sample_time.physical_time',
      target: 'samples', unit: 'millimeters', valuePath: 'heightMillimeters',
    })
  })

  it('declares core-body-temperature, an instant reading in celsius', () => {
    expect(dataTypeById('core-body-temperature')).toMatchObject({
      id: 'core-body-temperature', payloadKey: 'coreBodyTemperature',
      filterMember: 'sample_time.physical_time', target: 'samples',
      unit: 'celsius', valuePath: 'temperatureCelsius',
    })
  })

  it('declares blood-glucose, an instant reading in mg/dL', () => {
    expect(dataTypeById('blood-glucose')).toMatchObject({
      id: 'blood-glucose', payloadKey: 'bloodGlucose',
      filterMember: 'sample_time.physical_time', target: 'samples',
      unit: 'mg_dl', valuePath: 'bloodGlucoseMilligramsPerDeciliter',
    })
  })

  it('declares run-vo2-max, an instant reading in ml/kg/min', () => {
    expect(dataTypeById('run-vo2-max')).toMatchObject({
      id: 'run-vo2-max', payloadKey: 'runVo2Max',
      filterMember: 'sample_time.physical_time', target: 'samples',
      unit: 'ml_kg_min', valuePath: 'runVo2Max',
    })
  })

  it('declares altitude, an interval reading in millimeters attributed to the interval start', () => {
    expect(dataTypeById('altitude')).toMatchObject({
      id: 'altitude', payloadKey: 'altitude',
      filterMember: 'interval.start_time', target: 'samples',
      unit: 'millimeters', valuePath: 'gainMillimeters',
    })
  })

  it('maps a height reading, whose int64 value arrives as a JSON string', () => {
    const height = dataTypeById('height')!
    const rows = mapSamples({
      dataType: height, ...ctx,
      body: body([samplePoint({
        payloadKey: 'height', valuePath: 'heightMillimeters', value: '1700',
        physicalTime: '2026-08-18T08:00:00Z',
      })]),
    })
    expect(rows).toEqual([{
      personId: 'p1', sourceId: 's1', metric: height.metric, utcMs: Date.UTC(2026, 7, 18, 8, 0),
      tzOffsetMinutes: 120, agg: 'raw', value: 1700, n: 1, rawPayloadId: 'r1',
    }])
  })

  it('writes no row for height when heightMillimeters is absent', () => {
    const height = dataTypeById('height')!
    const rows = mapSamples({
      dataType: height, ...ctx,
      body: body([{ dataSource: {}, height: { sampleTime: { physicalTime: '2026-08-18T08:00:00Z', utcOffset: '7200s' } } }]),
    })
    expect(rows).toEqual([])
  })

  it('maps a core body temperature reading', () => {
    const cbt = dataTypeById('core-body-temperature')!
    const rows = mapSamples({
      dataType: cbt, ...ctx,
      body: body([samplePoint({
        payloadKey: 'coreBodyTemperature', valuePath: 'temperatureCelsius', value: 37.1,
        physicalTime: '2026-08-18T08:00:00Z',
      })]),
    })
    expect(rows).toEqual([{
      personId: 'p1', sourceId: 's1', metric: cbt.metric, utcMs: Date.UTC(2026, 7, 18, 8, 0),
      tzOffsetMinutes: 120, agg: 'raw', value: 37.1, n: 1, rawPayloadId: 'r1',
    }])
  })

  it('writes no row for core-body-temperature when temperatureCelsius is absent', () => {
    const cbt = dataTypeById('core-body-temperature')!
    const rows = mapSamples({
      dataType: cbt, ...ctx,
      body: body([{
        dataSource: {},
        coreBodyTemperature: {
          sampleTime: { physicalTime: '2026-08-18T08:00:00Z', utcOffset: '7200s' },
          measurementLocation: 'EAR',
        },
      }]),
    })
    expect(rows).toEqual([])
  })

  it('maps a blood glucose reading', () => {
    const glucose = dataTypeById('blood-glucose')!
    const rows = mapSamples({
      dataType: glucose, ...ctx,
      body: body([samplePoint({
        payloadKey: 'bloodGlucose', valuePath: 'bloodGlucoseMilligramsPerDeciliter', value: 95,
        physicalTime: '2026-08-18T08:00:00Z',
      })]),
    })
    expect(rows).toEqual([{
      personId: 'p1', sourceId: 's1', metric: glucose.metric, utcMs: Date.UTC(2026, 7, 18, 8, 0),
      tzOffsetMinutes: 120, agg: 'raw', value: 95, n: 1, rawPayloadId: 'r1',
    }])
  })

  it('writes no row for blood-glucose when bloodGlucoseMilligramsPerDeciliter is absent', () => {
    const glucose = dataTypeById('blood-glucose')!
    const rows = mapSamples({
      dataType: glucose, ...ctx,
      body: body([{
        dataSource: {},
        bloodGlucose: {
          sampleTime: { physicalTime: '2026-08-18T08:00:00Z', utcOffset: '7200s' },
          mealType: 'BREAKFAST', specimen: 'CAPILLARY_BLOOD',
          measurementSource: 'SELF_MONITORING_BLOOD_GLUCOSE', measurementTiming: 'FASTING',
        },
      }]),
    })
    expect(rows).toEqual([])
  })

  it('maps a run VO2 max reading', () => {
    const vo2max = dataTypeById('run-vo2-max')!
    const rows = mapSamples({
      dataType: vo2max, ...ctx,
      body: body([samplePoint({
        payloadKey: 'runVo2Max', valuePath: 'runVo2Max', value: 48.5,
        physicalTime: '2026-08-18T08:00:00Z',
      })]),
    })
    expect(rows).toEqual([{
      personId: 'p1', sourceId: 's1', metric: vo2max.metric, utcMs: Date.UTC(2026, 7, 18, 8, 0),
      tzOffsetMinutes: 120, agg: 'raw', value: 48.5, n: 1, rawPayloadId: 'r1',
    }])
  })

  it('writes no row for run-vo2-max when the value field is absent', () => {
    const vo2max = dataTypeById('run-vo2-max')!
    const rows = mapSamples({
      dataType: vo2max, ...ctx,
      body: body([{ dataSource: {}, runVo2Max: { sampleTime: { physicalTime: '2026-08-18T08:00:00Z', utcOffset: '7200s' } } }]),
    })
    expect(rows).toEqual([])
  })

  it('maps an altitude reading at its interval start, whose int64 value arrives as a JSON string', () => {
    const altitude = dataTypeById('altitude')!
    const rows = mapSamples({
      dataType: altitude, ...ctx,
      body: body([intervalPoint({
        payloadKey: 'altitude', valuePath: 'gainMillimeters', value: '5000',
        physicalTime: '2026-08-18T08:00:00Z', endTime: '2026-08-18T09:00:00Z',
      })]),
    })
    expect(rows).toEqual([{
      personId: 'p1', sourceId: 's1', metric: altitude.metric, utcMs: Date.UTC(2026, 7, 18, 8, 0),
      tzOffsetMinutes: 120, agg: 'raw', value: 5000, n: 1, rawPayloadId: 'r1',
    }])
  })

  it('writes no row for altitude when gainMillimeters is absent', () => {
    const altitude = dataTypeById('altitude')!
    const rows = mapSamples({
      dataType: altitude, ...ctx,
      body: body([{
        dataSource: {},
        altitude: {
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
