import { describe, expect, it } from 'vitest'
import { mapSamples } from '../src/api/mapSamples.ts'
import { dataTypeById, DATA_TYPES } from '../src/api/catalogue.ts'
import { samplePoint, intervalPoint, dailyPoint, body } from '../src/testing/payloads.ts'

const ctx = { personId: 'p1', sourceId: 's1', rawPayloadId: 'r1' }

describe('mapSamples', () => {
  it('maps an instantaneous reading to one row at its own instant', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    const rows = mapSamples({
      dataType: spo2, ...ctx,
      body: body([samplePoint({
        payloadKey: 'oxygenSaturation', valuePath: 'percentage', value: 97,
        physicalTime: '2026-08-18T22:30:00Z',
      })]),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      personId: 'p1', sourceId: 's1', metric: 'spo2', agg: 'mean', value: 97, n: 1,
      utcMs: Date.UTC(2026, 7, 18, 22, 30), tzOffsetMinutes: 120, rawPayloadId: 'r1',
    })
  })

  it('maps an interval reading at its start, which is what the filter member selects on', () => {
    const steps = dataTypeById('steps')!
    const rows = mapSamples({
      dataType: steps, ...ctx,
      body: body([intervalPoint({
        payloadKey: 'steps', valuePath: 'count', value: '128',
        physicalTime: '2026-08-18T10:00:00Z', endTime: '2026-08-18T10:01:00Z',
      })]),
    })
    expect(rows[0]).toMatchObject({ metric: 'steps', agg: 'sum', value: 128, utcMs: Date.UTC(2026, 7, 18, 10, 0) })
  })

  it('maps a daily type onto the start of its civil date', () => {
    const rhr = dataTypeById('daily-resting-heart-rate')!
    const rows = mapSamples({
      dataType: rhr, ...ctx,
      body: body([dailyPoint({
        payloadKey: 'dailyRestingHeartRate', valuePath: 'beatsPerMinute', value: '54',
        date: { year: 2026, month: 8, day: 18 },
      })]),
    })
    expect(rows[0]).toMatchObject({ metric: 'resting_heart_rate', value: 54, utcMs: Date.UTC(2026, 7, 18) })
  })

  it('parses an integer that arrives as a string', () => {
    const hr = dataTypeById('heart-rate')!
    const rows = mapSamples({
      dataType: hr, ...ctx,
      body: body([samplePoint({
        payloadKey: 'heartRate', valuePath: 'beatsPerMinute', value: '62',
        physicalTime: '2026-08-18T10:00:00Z',
      })]),
    })
    expect(rows.every((r) => typeof r.value === 'number')).toBe(true)
  })

  it('skips a point whose value is missing rather than writing a zero', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    const rows = mapSamples({
      dataType: spo2, ...ctx,
      body: body([{ dataSource: {}, oxygenSaturation: { sampleTime: { physicalTime: '2026-08-18T10:00:00Z' } } }]),
    })
    expect(rows).toHaveLength(0)
  })

  it('skips a point whose instant is unreadable rather than guessing one', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    const rows = mapSamples({
      dataType: spo2, ...ctx,
      body: body([{ dataSource: {}, oxygenSaturation: { percentage: 97 } }]),
    })
    expect(rows).toHaveLength(0)
  })

  it('tolerates a payload shaped in a way it has never seen', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    expect(() => mapSamples({ dataType: spo2, ...ctx, body: '{"unexpected":true}' })).not.toThrow()
    expect(mapSamples({ dataType: spo2, ...ctx, body: '{"unexpected":true}' })).toEqual([])
  })

  it('refuses a session type, which needs its own mapper', () => {
    const sleep = dataTypeById('sleep')!
    expect(() => mapSamples({ dataType: sleep, ...ctx, body: body([]) })).toThrow(/not a sample type/)
  })

  it('maps every deferred type to zero rows, driven from the catalogue', () => {
    for (const t of DATA_TYPES.filter((d) => d.mappingDeferred)) {
      const rows = mapSamples({
        dataType: t, ...ctx,
        body: body([samplePoint({
          payloadKey: t.payloadKey, valuePath: t.valuePath, value: 1,
          physicalTime: '2026-08-18T10:00:00Z',
        })]),
      })
      expect(rows).toHaveLength(0)
    }
  })

  it('maps nutrition-log to zero rows even given a well formed payload with a numeric calories field', () => {
    const nutritionLog = dataTypeById('nutrition-log')!
    const rows = mapSamples({
      dataType: nutritionLog, ...ctx,
      body: body([intervalPoint({
        payloadKey: 'nutritionLog', valuePath: 'calories', value: 500,
        physicalTime: '2026-08-18T10:00:00Z', endTime: '2026-08-18T10:30:00Z',
      })]),
    })
    expect(rows).toHaveLength(0)
  })
})
