import { describe, expect, it } from 'vitest'
import { dataTypeById } from '../src/api/catalogue.ts'
import { mapSessions } from '../src/api/mapSessions.ts'
import { mapSamples } from '../src/api/mapSamples.ts'
import { mapObservations } from '../src/api/mapObservations.ts'
import { body } from '../src/testing/payloads.ts'

// Shape measured against the v4 discovery document, 2026-09-06 -
// .superpowers/sdd/2026-09-06-catalogue-catches-up/api-schemas.md. beatsPerMinuteAvg is declared
// `string` (int64-as-string, same convention heart rate and height already use); the value here
// is a string on purpose rather than a number, since that is what the API actually sends.
// resultClassification's eight enum values are read verbatim off the schema file rather than
// invented. waveformSamples is non-empty on purpose: an empty array would let a mapper that
// walked it pass by accident, proving nothing about the assertion below.
const ctx = { personId: 'p1', resolveSource: () => 's1', rawPayloadId: 'r1' }
const ecg = dataTypeById('ecg')!

const aReading = {
  name: 'users/me/dataTypes/electrocardiogram/dataPoints/reading1',
  dataSource: {
    platform: 'FITBIT', recordingMethod: 'ACTIVELY_MEASURED',
    device: { displayName: 'Sense 2', formFactor: 'WATCH' },
  },
  electrocardiogram: {
    interval: {
      startTime: '2026-08-18T09:00:00Z', startUtcOffset: '7200s',
      endTime: '2026-08-18T09:00:30Z', endUtcOffset: '7200s',
    },
    beatsPerMinuteAvg: '72',
    resultClassification: 'ATRIAL_FIBRILLATION',
    // Thirty seconds at a plausible sampling rate - thousands in a real reading, a few hundred
    // here is enough to prove the point without bloating the fixture.
    waveformSamples: Array.from({ length: 500 }, (_, i) => i % 40),
    samplingFrequencyHertz: 250,
    millivoltsScalingFactor: 1,
    leadNumber: 1,
    medicalDeviceInfo: { manufacturer: 'Acme', model: 'Watch 9' },
  },
}

describe('catalogue: ecg declares itself correctly', () => {
  it('is session-shaped and names the two extra tables the same payload also writes', () => {
    expect(ecg).toMatchObject({
      id: 'ecg', payloadKey: 'electrocardiogram', filterMember: 'interval.start_time',
      scope: 'googlehealth.ecg.readonly',
      target: 'sessions', alsoTargets: ['samples', 'observations'],
      metric: 'ecg_heart_rate', unit: 'bpm', valuePath: 'beatsPerMinuteAvg',
    })
  })
})

describe('one ECG payload produces three things', () => {
  it('writes exactly one session row of kind ecg', () => {
    const { sessions } = mapSessions({ dataType: ecg, ...ctx, body: body([aReading]) })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      personId: 'p1', sourceId: 's1', kind: 'ecg',
      startMs: Date.parse('2026-08-18T09:00:00Z'),
      endMs: Date.parse('2026-08-18T09:00:30Z'),
    })
  })

  it('writes no session segments, because an ECG payload carries no stages array', () => {
    const { segments } = mapSessions({ dataType: ecg, ...ctx, body: body([aReading]) })
    expect(segments).toHaveLength(0)
  })

  // The assertion that matters most in this task: a TOTAL row count from mapSamples on a payload
  // whose waveformSamples is deliberately non-empty. A mapper that walked the waveform would add
  // hundreds of correct-looking rows here and a test only checking "no metric named waveform"
  // would never notice - this would.
  it('writes exactly one sample row - the averaged rate, parsed from its string payload value, and nothing derived from the waveform', () => {
    expect(aReading.electrocardiogram.waveformSamples.length).toBeGreaterThan(0)
    const rows = mapSamples({ dataType: ecg, ...ctx, body: body([aReading]) })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      personId: 'p1', sourceId: 's1', metric: 'ecg_heart_rate',
      utcMs: Date.parse('2026-08-18T09:00:00Z'), tzOffsetMinutes: 120,
      agg: 'raw', value: 72, n: 1,
    })
  })

  it('writes exactly one observation row for the classification', () => {
    const rows = mapObservations({ dataType: ecg, ...ctx, body: body([aReading]) })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      personId: 'p1', sourceId: 's1', kind: 'ecg_classification',
      value: 'ATRIAL_FIBRILLATION',
      startedAtMs: Date.parse('2026-08-18T09:00:00Z'),
      startedAtOffsetMinutes: 120,
      endedAtMs: Date.parse('2026-08-18T09:00:30Z'),
      endedAtOffsetMinutes: 120,
    })
  })
})
