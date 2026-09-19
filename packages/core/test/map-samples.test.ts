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
      personId: 'p1', sourceId: 's1', metric: 'spo2', agg: 'raw', value: 97, n: 1,
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
    expect(rows[0]).toMatchObject({ metric: 'steps', agg: 'raw', value: 128, utcMs: Date.UTC(2026, 7, 18, 10, 0) })
  })

  /**
   * The companion route archives the one identity a request carries beside its points, because
   * that is the identity the live write used. A rebuild replays from the archive alone, so a
   * mapper that only ever looked inside a point would file every one of those rows under
   * `unknown` the first time somebody bumped the mapping version.
   */
  it('reads the source a page names for all of its points', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    const seen: unknown[] = []
    const rows = mapSamples({
      dataType: spo2, personId: 'p1', rawPayloadId: 'r1',
      resolveSource: (dataSource) => { seen.push(dataSource); return 's1' },
      body: JSON.stringify({
        dataSource: { platform: 'HEALTH_CONNECT', device: { displayName: 'Pixel Watch 3' } },
        dataPoints: [{
          oxygenSaturation: {
            sampleTime: { physicalTime: '2026-08-18T22:30:00Z', utcOffset: '7200s' },
            percentage: 97,
          },
        }],
      }),
    })

    expect(rows).toHaveLength(1)
    expect(seen).toEqual([{ platform: 'HEALTH_CONNECT', device: { displayName: 'Pixel Watch 3' } }])
  })

  it('still prefers the source a point names for itself', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    const seen: unknown[] = []
    const own = { platform: 'FITBIT', recordingMethod: 'DERIVED' }
    mapSamples({
      dataType: spo2, personId: 'p1', rawPayloadId: 'r1',
      resolveSource: (dataSource) => { seen.push(dataSource); return 's1' },
      body: JSON.stringify({
        dataSource: { platform: 'HEALTH_CONNECT', device: { displayName: 'Pixel Watch 3' } },
        dataPoints: [samplePoint({
          payloadKey: 'oxygenSaturation', valuePath: 'percentage', value: 97,
          physicalTime: '2026-08-18T22:30:00Z', dataSource: own,
        })],
      }),
    })

    expect(seen).toEqual([own])
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

  it('splits active minutes into one metric per activity level', () => {
    // The sub-dimension goes in the metric name, which is what lets each be an ordinary metric
    // with an ordinary rollup and no collision on the samples natural key.
    const body = JSON.stringify({
      dataPoints: [{
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        activeMinutes: {
          interval: {
            startTime: '2026-08-21T08:00:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-21T09:00:00Z', endUtcOffset: '7200s',
          },
          activeMinutesByActivityLevel: [
            { activityLevel: 'LIGHT', activeMinutes: '20' },
            { activityLevel: 'VIGOROUS', activeMinutes: '5' },
          ],
        },
      }],
    })
    const rows = mapSamples({
      dataType: dataTypeById('active-minutes')!, body, personId: 'p1',
      resolveSource: () => 'watch', rawPayloadId: 'raw1',
    })
    expect(rows.map((r) => [r.metric, r.value])).toEqual([
      ['active_minutes_light', 20],
      ['active_minutes_vigorous', 5],
    ])
    // Same interval, different metric, so the natural key no longer collides.
    expect(new Set(rows.map((r) => r.utcMs)).size).toBe(1)
  })

  it('gives each heart rate zone its own metric, which is what the deferral was about', () => {
    const point = (zone: string, minutes: string) => ({
      dataSource: { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' },
      activeZoneMinutes: {
        interval: {
          startTime: '2026-08-21T08:00:00Z', startUtcOffset: '7200s',
          endTime: '2026-08-21T09:00:00Z', endUtcOffset: '7200s',
        },
        heartRateZone: zone,
        activeZoneMinutes: minutes,
      },
    })
    const body = JSON.stringify({ dataPoints: [point('FAT_BURN', '12'), point('PEAK', '3')] })
    const rows = mapSamples({
      dataType: dataTypeById('active-zone-minutes')!, body, personId: 'p1',
      resolveSource: () => 'watch', rawPayloadId: 'raw1',
    })
    expect(rows.map((r) => [r.metric, r.value])).toEqual([
      ['active_zone_minutes_fat_burn', 12],
      ['active_zone_minutes_peak', 3],
    ])
  })

  it('skips a level or zone the field map never recorded, rather than inventing a metric', () => {
    // A seventh value appearing upstream is schema drift. Writing it to a metric nobody declared
    // would put a series on a chart that no catalogue entry describes, silently.
    const body = JSON.stringify({
      dataPoints: [{
        dataSource: { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' },
        activeZoneMinutes: {
          interval: {
            startTime: '2026-08-21T08:00:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-21T09:00:00Z', endUtcOffset: '7200s',
          },
          heartRateZone: 'SOMETHING_NEW',
          activeZoneMinutes: '9',
        },
      }],
    })
    expect(mapSamples({
      dataType: dataTypeById('active-zone-minutes')!, body, personId: 'p1',
      resolveSource: () => 'watch', rawPayloadId: 'raw1',
    })).toEqual([])
  })

  // Guards the ordinary-row-plus-sub-dimension-rows generalisation Task 5 adds: every
  // sub-dimension type the catalogue declares today has an empty valuePath, which is exactly
  // the case that must keep skipping the ordinary branch. Driven from the catalogue, like the
  // deferred-type guard above, so a type added later without a valuePath is covered too.
  it('writes only sub-dimension rows for a type whose valuePath is empty, same as before the ordinary-plus-sub-dimension generalisation', () => {
    for (const t of DATA_TYPES.filter((d) => d.subDimension)) {
      expect(t.valuePath, t.id).toBe('')
    }
    // active-minutes: two sub-dimension rows from one point, and never a third, unqualified row
    // for the same point - the exact count from 'splits active minutes...' above, re-asserted as
    // the guard the generalisation must leave untouched.
    const activeMinutesBody = JSON.stringify({
      dataPoints: [{
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        activeMinutes: {
          interval: {
            startTime: '2026-08-21T08:00:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-21T09:00:00Z', endUtcOffset: '7200s',
          },
          activeMinutesByActivityLevel: [
            { activityLevel: 'LIGHT', activeMinutes: '20' },
            { activityLevel: 'VIGOROUS', activeMinutes: '5' },
          ],
        },
      }],
    })
    const rows = mapSamples({
      dataType: dataTypeById('active-minutes')!, body: activeMinutesBody, personId: 'p1',
      resolveSource: () => 'watch', rawPayloadId: 'raw1',
    })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.metric !== 'active_minutes')).toBe(true)
  })

  // The new capability the same generalisation exists to add: Task 7's nutrition log needs both
  // an ordinary row (its top-level energy) and sub-dimension rows (its macronutrient array) from
  // one payload. No catalogue entry declares this combination yet, so it is exercised here
  // against a synthetic type built from active-minutes' own sub-dimension.
  it('writes an ordinary row and sub-dimension rows from the same point when a type declares both', () => {
    const hybrid = { ...dataTypeById('active-minutes')!, valuePath: 'totalMinutes' }
    const body = JSON.stringify({
      dataPoints: [{
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        activeMinutes: {
          interval: {
            startTime: '2026-08-21T08:00:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-21T09:00:00Z', endUtcOffset: '7200s',
          },
          totalMinutes: '25',
          activeMinutesByActivityLevel: [{ activityLevel: 'LIGHT', activeMinutes: '20' }],
        },
      }],
    })
    const rows = mapSamples({
      dataType: hybrid, body, personId: 'p1', resolveSource: () => 'watch', rawPayloadId: 'raw1',
    })
    expect(rows.map((r) => [r.metric, r.value])).toEqual([
      ['active_minutes', 25],
      ['active_minutes_light', 20],
    ])
  })

  // The other Task 5 generalisation: a type may write here as an extra target named in
  // alsoTargets, not only as its primary one, without the guard refusing it as foreign.
  it('accepts a type whose primary target is foreign when alsoTargets names samples', () => {
    const hybrid = { ...dataTypeById('sleep')!, target: 'sessions' as const, alsoTargets: ['samples'] as const }
    expect(() => mapSamples({ dataType: hybrid, ...ctx, body: body([]) })).not.toThrow()
  })

  it('still refuses a foreign target with no alsoTargets naming this one, unchanged from before', () => {
    const sleep = dataTypeById('sleep')!
    expect(sleep.alsoTargets).toBeUndefined()
    expect(() => mapSamples({ dataType: sleep, ...ctx, body: body([]) })).toThrow(/not a sample type/)
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
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((r) => r.agg))).toEqual(new Set(['min', 'mean', 'max', 'count']))
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
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.n === 6)).toBe(true)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(rows.find((r) => r.agg === 'mean')?.value).toBeCloseTo(mean, 10)
  })
})
