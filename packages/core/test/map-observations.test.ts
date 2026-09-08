import { describe, expect, it } from 'vitest'
import { mapObservations } from '../src/api/mapObservations.ts'
import { dataTypeById } from '../src/api/catalogue.ts'
import type { DataType } from '../src/api/catalogue.ts'
import { body } from '../src/testing/payloads.ts'

const ctx = { personId: 'p1', resolveSource: () => 's1', rawPayloadId: 'r1' }

// Read from the catalogue rather than hand-built. This file used to construct its own DataType
// literal for each of these five ids, on the reasoning that Task 5 committed the mapper before
// the catalogue entries existed. That gap closed once group C landed, and the copy was never
// removed - so when irregular-rhythm-notification's real filterMember was wrong (finding 2), this
// file's own hand-built copy just repeated the same mistake and agreed with it instead of
// catching it. A mapper test that invents its own copy of a real entry can only ever agree with
// itself; reading dataTypeById means a future drift here fails this file too, not just
// catalogue-group-c.test.ts.
const ovulationTest = dataTypeById('ovulation-test')!
const moods = dataTypeById('moods')!
const symptoms = dataTypeById('symptoms')!
const menstrualPeriod = dataTypeById('menstrual-period')!
const irregularRhythm = dataTypeById('irregular-rhythm-notification')!

describe('mapObservations', () => {
  it('maps an ovulation test to one row carrying the API\'s own enum spelling', () => {
    const rows = mapObservations({
      dataType: ovulationTest, ...ctx,
      body: body([{
        dataSource: { platform: 'FITBIT', recordingMethod: 'ACTIVELY_MEASURED' },
        ovulationTest: {
          sampleTime: { physicalTime: '2026-08-18T09:00:00Z', utcOffset: '7200s' },
          result: 'POSITIVE',
        },
      }]),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      personId: 'p1', sourceId: 's1', kind: 'ovulation_test',
      startedAtMs: Date.parse('2026-08-18T09:00:00Z'), startedAtOffsetMinutes: 120,
      endedAtMs: null, endedAtOffsetMinutes: null,
      localDate: '2026-08-18', value: 'POSITIVE', rawPayloadId: 'r1',
    })
  })

  it('maps one row per element of moods[], and does not map valences[] at all', () => {
    const rows = mapObservations({
      dataType: moods, ...ctx,
      body: body([{
        dataSource: { platform: 'FITBIT', recordingMethod: 'ACTIVELY_MEASURED' },
        moods: {
          sampleTime: { physicalTime: '2026-08-18T09:00:00Z', utcOffset: '7200s' },
          // 57 measured values in the enum (api-schemas.md); these two are real members of it.
          moods: ['HAPPY', 'CALM'],
          valences: ['PLEASANT', 'BASELINE'],
        },
      }]),
    })
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.value)).toEqual(['HAPPY', 'CALM'])
    expect(rows.every((r) => r.kind === 'mood')).toBe(true)
    // Neither PLEASANT nor BASELINE (the parallel valences[] entries) ever appears as a value:
    // pairing a mood with its valence is a decision this mapper does not make.
    expect(rows.some((r) => r.value === 'PLEASANT' || r.value === 'BASELINE')).toBe(false)
  })

  it('maps one row per element of symptoms[], asserting the exact count for a three element array', () => {
    const rows = mapObservations({
      dataType: symptoms, ...ctx,
      body: body([{
        dataSource: { platform: 'FITBIT', recordingMethod: 'ACTIVELY_MEASURED' },
        symptoms: {
          sampleTime: { physicalTime: '2026-08-18T09:00:00Z', utcOffset: '7200s' },
          // Three real members of the 65 value enum (api-schemas.md).
          symptoms: ['CRAMPS', 'HEADACHE', 'BLOATED'],
        },
      }]),
    })
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.value)).toEqual(['CRAMPS', 'HEADACHE', 'BLOATED'])
    expect(rows.every((r) => r.kind === 'symptom')).toBe(true)
  })

  it('maps a menstrual period to an interval row with a null value, archiving notes rather than storing it', () => {
    const rows = mapObservations({
      dataType: menstrualPeriod, ...ctx,
      body: body([{
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        menstrualPeriod: {
          interval: {
            startTime: '2026-08-18T00:00:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-22T00:00:00Z', endUtcOffset: '7200s',
          },
          notes: 'heavy flow',
        },
      }]),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'menstrual_period',
      startedAtMs: Date.parse('2026-08-18T00:00:00Z'), startedAtOffsetMinutes: 120,
      endedAtMs: Date.parse('2026-08-22T00:00:00Z'), endedAtOffsetMinutes: 120,
      value: null,
    })
  })

  it('maps an irregular rhythm notification to an interval row, archiving alertWindows rather than storing it', () => {
    const rows = mapObservations({
      dataType: irregularRhythm, ...ctx,
      body: body([{
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        irregularRhythmNotification: {
          interval: {
            startTime: '2026-08-18T09:00:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-18T09:05:00Z', endUtcOffset: '7200s',
          },
          alertWindows: [{ startTime: '2026-08-18T09:00:00Z', endTime: '2026-08-18T09:05:00Z' }],
          medicalDeviceInfo: { manufacturer: 'Acme', model: 'Watch' },
        },
      }]),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'irregular_rhythm',
      startedAtMs: Date.parse('2026-08-18T09:00:00Z'), startedAtOffsetMinutes: 120,
      endedAtMs: Date.parse('2026-08-18T09:05:00Z'), endedAtOffsetMinutes: 120,
      value: null,
    })
  })

  it('writes no row for a point type with no sampleTime, rather than inventing a clock', () => {
    const rows = mapObservations({
      dataType: ovulationTest, ...ctx,
      body: body([{ dataSource: {}, ovulationTest: { result: 'POSITIVE' } }]),
    })
    expect(rows).toEqual([])
  })

  it('writes no row for an interval type missing an end, rather than inventing a clock', () => {
    const rows = mapObservations({
      dataType: menstrualPeriod, ...ctx,
      body: body([{
        dataSource: {},
        menstrualPeriod: { interval: { startTime: '2026-08-18T00:00:00Z', startUtcOffset: '7200s' } },
      }]),
    })
    expect(rows).toEqual([])
  })

  it('tolerates a body that is not JSON', () => {
    expect(() => mapObservations({ dataType: ovulationTest, ...ctx, body: 'not json' })).not.toThrow()
    expect(mapObservations({ dataType: ovulationTest, ...ctx, body: 'not json' })).toEqual([])
  })

  it('tolerates a body that parses to a JSON null rather than an object', () => {
    expect(mapObservations({ dataType: ovulationTest, ...ctx, body: 'null' })).toEqual([])
  })

  it('tolerates dataPoints arriving as something other than an array', () => {
    const rows = mapObservations({
      dataType: ovulationTest, ...ctx, body: JSON.stringify({ dataPoints: { cursor1: {} } }),
    })
    expect(rows).toEqual([])
  })

  it('refuses a type whose target is neither observations nor named in alsoTargets', () => {
    const foreign: DataType = { ...ovulationTest, target: 'samples' }
    expect(() => mapObservations({ dataType: foreign, ...ctx, body: body([]) }))
      .toThrow(/not an observation type/)
  })

  it('accepts a type whose primary target is foreign when alsoTargets names observations', () => {
    const hybrid: DataType = { ...ovulationTest, target: 'samples', alsoTargets: ['observations'] }
    expect(() => mapObservations({ dataType: hybrid, ...ctx, body: body([]) })).not.toThrow()
  })
})
