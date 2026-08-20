import { describe, expect, it } from 'vitest'
import { mapSamples, mapWindowSamples } from '../src/api/mapSamples.ts'
import { dataTypeById, DATA_TYPES } from '../src/api/catalogue.ts'
import { samplePoint, intervalPoint, dailyPoint, body } from '../src/testing/payloads.ts'

const ctx = { personId: 'p1', resolveSource: () => 's1', rawPayloadId: 'r1' }

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
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe(62)
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

  it('tolerates a body that parses to a JSON null rather than an object', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    expect(() => mapSamples({ dataType: spo2, ...ctx, body: 'null' })).not.toThrow()
    expect(mapSamples({ dataType: spo2, ...ctx, body: 'null' })).toEqual([])
  })

  it('tolerates a body that parses to a bare JSON number rather than an object', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    expect(() => mapSamples({ dataType: spo2, ...ctx, body: '42' })).not.toThrow()
    expect(mapSamples({ dataType: spo2, ...ctx, body: '42' })).toEqual([])
  })

  it('tolerates dataPoints arriving as a number instead of an array', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    const rows = mapSamples({ dataType: spo2, ...ctx, body: JSON.stringify({ dataPoints: 7 }) })
    expect(() => rows).not.toThrow()
    expect(rows).toEqual([])
  })

  it('tolerates dataPoints arriving as a cursor-keyed object instead of an array', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    const rows = mapSamples({
      dataType: spo2, ...ctx,
      body: JSON.stringify({ dataPoints: { cursor1: { oxygenSaturation: { percentage: 97 } } } }),
    })
    expect(rows).toEqual([])
  })

  it('skips a bare string entry inside dataPoints while mapping its well formed siblings', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    const rows = mapSamples({
      dataType: spo2, ...ctx,
      body: body([
        'not a point',
        samplePoint({
          payloadKey: 'oxygenSaturation', valuePath: 'percentage', value: 96,
          physicalTime: '2026-08-18T10:00:00Z',
        }),
      ]),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ value: 96 })
  })

  it('does not downsample on its own; a page is not a minute', () => {
    const hr = dataTypeById('heart-rate')!
    const points = Array.from({ length: 30 }, (_, i) => samplePoint({
      payloadKey: 'heartRate', valuePath: 'beatsPerMinute', value: String(60 + i),
      physicalTime: new Date(Date.UTC(2026, 7, 18, 10, 0, i * 2)).toISOString(),
    }))
    const rows = mapSamples({ dataType: hr, ...ctx, body: body(points) })
    expect(rows).toHaveLength(30)
    expect(rows.every((r) => r.n === 1)).toBe(true)
  })

  it('leaves a type that is not downsampled alone', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    const points = Array.from({ length: 5 }, (_, i) => samplePoint({
      payloadKey: 'oxygenSaturation', valuePath: 'percentage', value: 95 + i,
      physicalTime: new Date(Date.UTC(2026, 7, 18, 10, 0, i * 2)).toISOString(),
    }))
    expect(mapSamples({ dataType: spo2, ...ctx, body: body(points) })).toHaveLength(5)
  })

  it('attributes each row to its own point source rather than one source for the whole body', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    const fitbitPoint = samplePoint({
      payloadKey: 'oxygenSaturation', valuePath: 'percentage', value: 97,
      physicalTime: '2026-08-18T10:00:00Z', dataSource: { platform: 'FITBIT' },
    })
    const healthConnectPoint = samplePoint({
      payloadKey: 'oxygenSaturation', valuePath: 'percentage', value: 96,
      physicalTime: '2026-08-18T11:00:00Z', dataSource: { platform: 'HEALTH_CONNECT' },
    })
    const rows = mapSamples({
      dataType: spo2, personId: 'p1', rawPayloadId: 'r1',
      resolveSource: (dataSource) => (dataSource as { platform: string }).platform,
      body: body([fitbitPoint, healthConnectPoint]),
    })
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.sourceId)).toEqual(['FITBIT', 'HEALTH_CONNECT'])
  })
})

describe('mapWindowSamples', () => {
  it('downsamples heart rate collected over a single page, because 2 second sampling is 95 percent of all rows', () => {
    const hr = dataTypeById('heart-rate')!
    const points = Array.from({ length: 30 }, (_, i) => samplePoint({
      payloadKey: 'heartRate', valuePath: 'beatsPerMinute', value: String(60 + i),
      physicalTime: new Date(Date.UTC(2026, 7, 18, 10, 0, i * 2)).toISOString(),
    }))
    const rows = mapWindowSamples({
      dataType: hr, personId: ctx.personId, resolveSource: ctx.resolveSource,
      pages: [{ body: body(points), rawPayloadId: ctx.rawPayloadId }],
    })
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.agg))).toEqual(new Set(['min', 'mean', 'max']))
    expect(rows[0]?.n).toBe(30)
  })

  it('downsamples once over the whole window rather than once per page, when a minute straddles a page boundary', () => {
    const hr = dataTypeById('heart-rate')!
    const values = [60, 61, 62, 63, 64, 65]
    const firstPage = values.slice(0, 4).map((v, i) => samplePoint({
      payloadKey: 'heartRate', valuePath: 'beatsPerMinute', value: String(v),
      physicalTime: new Date(Date.UTC(2026, 7, 18, 10, 0, i * 10)).toISOString(),
    }))
    const secondPage = values.slice(4).map((v, i) => samplePoint({
      payloadKey: 'heartRate', valuePath: 'beatsPerMinute', value: String(v),
      physicalTime: new Date(Date.UTC(2026, 7, 18, 10, 0, 40 + i * 10)).toISOString(),
    }))
    const rows = mapWindowSamples({
      dataType: hr, personId: ctx.personId, resolveSource: ctx.resolveSource,
      pages: [
        { body: body(firstPage), rawPayloadId: 'r1' },
        { body: body(secondPage), rawPayloadId: 'r2' },
      ],
    })
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.n === 6)).toBe(true)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(rows.find((r) => r.agg === 'mean')?.value).toBeCloseTo(mean, 10)
  })
})
