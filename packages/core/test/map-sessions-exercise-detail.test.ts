import { describe, expect, it } from 'vitest'
import { mapSessions } from '../src/api/mapSessions.ts'
import { dataTypeById } from '../src/api/catalogue.ts'
import { body } from '../src/testing/payloads.ts'

const ctx = { personId: 'p1', resolveSource: () => 's1', rawPayloadId: 'r1' }
const exercise = dataTypeById('exercise')!

// The field names and nesting are taken from the v4 Exercise schema and confirmed against real
// payloads in probe/findings/field-map.md, a four-point sample from M0. A fuller read-only probe
// taken 2026-09-11 replaced that sample: across 197 distinct sessions, splitSummaries is absent
// from every one of them, and every splitType this household's devices have ever recorded is
// DISTANCE - so the "absent" test below covers the case that never varies. notes is observed but
// rare, 4 of 197, so it is mapped because the archive holds it, not only because the schema does;
// the fixture above, where notes is present, covers the less common but real case.
const aRunWithEverything = {
  name: 'users/me/dataTypes/exercise/dataPoints/run1',
  dataSource: { platform: 'FITBIT', recordingMethod: 'ACTIVELY_MEASURED' },
  exercise: {
    interval: {
      startTime: '2026-08-18T06:00:00Z', startUtcOffset: '7200s',
      endTime: '2026-08-18T06:30:00Z', endUtcOffset: '7200s',
    },
    exerciseType: 'RUNNING',
    displayName: 'Evening Run',
    notes: 'legs felt heavy',
    activeDuration: '1680s',
    exerciseMetadata: { hasGps: true, poolLengthMillimeters: '25000' },
    exerciseEvents: [
      { eventTime: '2026-08-18T06:10:00Z', eventUtcOffset: '7200s', exerciseEventType: 'PAUSE' },
      { eventTime: '2026-08-18T06:12:00Z', eventUtcOffset: '7200s', exerciseEventType: 'RESUME' },
    ],
    splits: [
      {
        startTime: '2026-08-18T06:00:00Z', startUtcOffset: '7200s',
        endTime: '2026-08-18T06:06:19Z', endUtcOffset: '7200s',
        activeDuration: '379s', splitType: 'DISTANCE',
        metricsSummary: { distanceMillimeters: 1_000_000, averagePaceSecondsPerMeter: 0.379 },
      },
    ],
    splitSummaries: [
      {
        startTime: '2026-08-18T06:00:00Z', startUtcOffset: '7200s',
        endTime: '2026-08-18T06:15:00Z', endUtcOffset: '7200s',
        activeDuration: '900s', splitType: 'MANUAL',
        metricsSummary: { distanceMillimeters: 2_400_000, averageHeartRateBeatsPerMinute: '154' },
      },
    ],
  },
}

// Everything the widening adds, absent. This is the shape most real sessions have.
const aBareWorkout = {
  name: 'users/me/dataTypes/exercise/dataPoints/walk1',
  dataSource: { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' },
  exercise: {
    interval: {
      startTime: '2026-08-18T09:00:00Z', startUtcOffset: '7200s',
      endTime: '2026-08-18T09:20:00Z', endUtcOffset: '7200s',
    },
    exerciseType: 'WALKING',
  },
}

const attrsOf = (point: unknown): Record<string, unknown> => {
  const { sessions } = mapSessions({ dataType: exercise, ...ctx, body: body([point]) })
  return JSON.parse(sessions[0]?.attrs ?? '{}') as Record<string, unknown>
}

describe('mapSessions carries a withheld route into attrs', () => {
  // The companion app sends this beside `route` on the exercise payload when Health Connect
  // answered ConsentRequired: a track that exists and was not released, as opposed to a workout
  // with no track. Both arrive as no route points, which is why the flag has to be carried
  // separately for anything downstream to tell them apart.
  it('keeps the flag a workout sends when its route was withheld', () => {
    const attrs = attrsOf({
      ...aBareWorkout,
      exercise: { ...aBareWorkout.exercise, routeConsentRequired: true },
    })
    expect(attrs.routeConsentRequired).toBe(true)
  })

  it('leaves it null for a workout that says nothing about a route', () => {
    // Every Google session, and every companion session with nothing to withhold. Null rather than
    // false, the same as every other unmapped field here: this is the mapper reporting the payload
    // was silent, and workoutDetail is where that becomes a boolean.
    expect(attrsOf(aBareWorkout).routeConsentRequired).toBeNull()
  })

  it('reads it off the payload, not off the point beside it', () => {
    // The level mistake this wire shape has already made once, with `name`. A flag put on the point
    // rather than inside `exercise` must not be picked up, or the guard in SyncEngine.kt that keeps
    // the app writing it in the right place would be guarding nothing.
    const attrs = attrsOf({ ...aBareWorkout, routeConsentRequired: true })
    expect(attrs.routeConsentRequired).toBeNull()
  })
})

describe('mapSessions carries the exercise detail fields into attrs', () => {
  it('keeps both split arrays, each entry whole', () => {
    const attrs = attrsOf(aRunWithEverything)
    expect(attrs.splits).toEqual([{
      startTime: '2026-08-18T06:00:00Z', startUtcOffset: '7200s',
      endTime: '2026-08-18T06:06:19Z', endUtcOffset: '7200s',
      activeDuration: '379s', splitType: 'DISTANCE',
      metricsSummary: { distanceMillimeters: 1_000_000, averagePaceSecondsPerMeter: 0.379 },
    }])
    expect(attrs.splitSummaries).toEqual([{
      startTime: '2026-08-18T06:00:00Z', startUtcOffset: '7200s',
      endTime: '2026-08-18T06:15:00Z', endUtcOffset: '7200s',
      activeDuration: '900s', splitType: 'MANUAL',
      metricsSummary: { distanceMillimeters: 2_400_000, averageHeartRateBeatsPerMinute: '154' },
    }])
  })

  it('keeps the pause events, the moving time, the name, the notes and the metadata', () => {
    const attrs = attrsOf(aRunWithEverything)
    expect(attrs.exerciseEvents).toEqual([
      { eventTime: '2026-08-18T06:10:00Z', eventUtcOffset: '7200s', exerciseEventType: 'PAUSE' },
      { eventTime: '2026-08-18T06:12:00Z', eventUtcOffset: '7200s', exerciseEventType: 'RESUME' },
    ])
    expect(attrs.activeDuration).toBe('1680s')
    expect(attrs.displayName).toBe('Evening Run')
    expect(attrs.notes).toBe('legs felt heavy')
    expect(attrs.exerciseMetadata).toEqual({ hasGps: true, poolLengthMillimeters: '25000' })
  })

  it('resolves every added field to null on a workout that carries none of them', () => {
    const attrs = attrsOf(aBareWorkout)
    for (const key of [
      'splits', 'splitSummaries', 'exerciseEvents',
      'activeDuration', 'displayName', 'notes', 'exerciseMetadata',
    ]) {
      expect(attrs[key], `${key} should be null when the payload omits it`).toBeNull()
    }
    // The seven keys that were already there are untouched by the widening.
    expect(attrs.exerciseType).toBe('WALKING')
  })

  it('keeps an empty array as an empty array, not as null', () => {
    const attrs = attrsOf({
      ...aBareWorkout,
      exercise: { ...aBareWorkout.exercise, splits: [], exerciseEvents: [] },
    })
    // "The provider sent no splits" and "the provider sent a split list that was empty" are
    // different statements, and valueAt returns the array it found. A mapper that folded [] to
    // null would erase the distinction before any reader could see it.
    expect(attrs.splits).toEqual([])
    expect(attrs.exerciseEvents).toEqual([])
  })

  it('resolves the exercise detail fields to null on a sleep session', () => {
    // attrs is one shape across both kinds (mapSessions' own comment says so), so a sleep row
    // carries these keys set to null rather than not carrying them at all.
    const sleep = dataTypeById('sleep')!
    const { sessions } = mapSessions({
      dataType: sleep, ...ctx,
      body: body([{
        name: 'users/me/dataTypes/sleep/dataPoints/n1',
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        sleep: {
          interval: {
            startTime: '2026-08-17T21:30:00Z', startUtcOffset: '7200s',
            endTime: '2026-08-18T05:15:00Z', endUtcOffset: '7200s',
          },
          type: 'STAGES',
          metadata: { mainSleep: true, stagesStatus: 'SUCCEEDED' },
          stages: [],
        },
      }]),
    })
    const attrs = JSON.parse(sessions[0]?.attrs ?? '{}') as Record<string, unknown>
    expect(attrs.splits).toBeNull()
    expect(attrs.displayName).toBeNull()
    expect(attrs.mainSleep).toBe(true)
  })
})
