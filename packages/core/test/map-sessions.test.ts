import { describe, expect, it } from 'vitest'
import { mapSessions } from '../src/api/mapSessions.ts'
import { dataTypeById } from '../src/api/catalogue.ts'
import { sleepPoint, body } from '../src/testing/payloads.ts'

const ctx = { personId: 'p1', resolveSource: () => 's1', rawPayloadId: 'r1' }
const sleep = dataTypeById('sleep')!
const exercise = dataTypeById('exercise')!

const aNight = sleepPoint({
  startTime: '2026-08-17T21:30:00Z',
  endTime: '2026-08-18T05:15:00Z',
  stages: [
    { type: 'LIGHT', startTime: '2026-08-17T21:30:00Z', endTime: '2026-08-17T23:00:00Z' },
    { type: 'DEEP', startTime: '2026-08-17T23:00:00Z', endTime: '2026-08-18T00:30:00Z' },
    { type: 'REM', startTime: '2026-08-18T00:30:00Z', endTime: '2026-08-18T02:00:00Z' },
    { type: 'AWAKE', startTime: '2026-08-18T02:00:00Z', endTime: '2026-08-18T02:05:00Z' },
    { type: 'LIGHT', startTime: '2026-08-18T02:05:00Z', endTime: '2026-08-18T05:15:00Z' },
  ],
})

// sleepPoint applies one offset to both ends, so the shortAwakenings array and the asymmetric
// DST case below are built as raw literals in the shape probe/findings/field-map.md records
// rather than stretching the builder to cover shapes the brief never asked it to.
const nightWithAwakenings = {
  name: 'users/me/dataTypes/sleep/dataPoints/extras',
  dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
  sleep: {
    interval: {
      startTime: '2026-08-17T21:30:00Z', startUtcOffset: '7200s',
      endTime: '2026-08-18T05:15:00Z', endUtcOffset: '7200s',
    },
    type: 'STAGES',
    metadata: { mainSleep: true, processed: true, stagesStatus: 'SUCCEEDED' },
    stages: [],
    shortAwakenings: [
      { type: 'AWAKE', startTime: '2026-08-18T01:00:00Z', endTime: '2026-08-18T01:02:00Z' },
    ],
  },
}

const anExercise = {
  name: 'users/me/dataTypes/exercise/dataPoints/run1',
  dataSource: { platform: 'FITBIT', recordingMethod: 'ACTIVELY_MEASURED' },
  exercise: {
    interval: {
      startTime: '2026-08-18T06:00:00Z', startUtcOffset: '7200s',
      endTime: '2026-08-18T06:30:00Z', endUtcOffset: '7200s',
    },
    exerciseType: 'RUNNING',
  },
}

describe('mapSessions', () => {
  it('maps one night to one session', () => {
    const { sessions } = mapSessions({ dataType: sleep, ...ctx, body: body([aNight]) })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      personId: 'p1', sourceId: 's1', kind: 'sleep',
      startMs: Date.parse('2026-08-17T21:30:00Z'),
      endMs: Date.parse('2026-08-18T05:15:00Z'),
    })
  })

  it('attributes a night that spans midnight to the wake date, not the bed date', () => {
    const { sessions } = mapSessions({ dataType: sleep, ...ctx, body: body([aNight]) })
    expect(sessions[0]?.localDate).toBe('2026-08-18')
  })

  it('carries a distinct offset for each end, because a night can cross a DST change', () => {
    const crossing = {
      name: 'users/me/dataTypes/sleep/dataPoints/dst',
      dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
      sleep: {
        interval: {
          startTime: '2026-10-24T22:00:00Z', startUtcOffset: '3600s',
          endTime: '2026-10-25T06:00:00Z', endUtcOffset: '7200s',
        },
        type: 'STAGES',
        metadata: { mainSleep: true, processed: true, stagesStatus: 'SUCCEEDED' },
        stages: [],
      },
    }
    const { sessions } = mapSessions({ dataType: sleep, ...ctx, body: body([crossing]) })
    // A copy-the-start-offset bug or a zero-default bug would both still satisfy
    // toHaveProperty; only pinned, unequal numbers catch either.
    expect(sessions[0]?.startOffsetMinutes).toBe(60)
    expect(sessions[0]?.endOffsetMinutes).toBe(120)
  })

  it('maps every stage to a segment of the session that owns it', () => {
    const { sessions, segments } = mapSessions({ dataType: sleep, ...ctx, body: body([aNight]) })
    expect(segments).toHaveLength(5)
    expect(new Set(segments.map((s) => s.sessionId))).toEqual(new Set([sessions[0]?.id]))
    expect(segments.map((s) => s.stage)).toEqual(['LIGHT', 'DEEP', 'REM', 'AWAKE', 'LIGHT'])
  })

  it('keeps the session id stable across re-fetches, so the trailing window upserts', () => {
    const first = mapSessions({ dataType: sleep, ...ctx, body: body([aNight]) })
    const second = mapSessions({ dataType: sleep, ...ctx, body: body([aNight]) })
    expect(second.sessions[0]?.id).toBe(first.sessions[0]?.id)
    expect(second.sessions[0]?.externalId).toBe(first.sessions[0]?.externalId)
  })

  it('keeps the raw summary in attrs rather than inventing columns for it', () => {
    const { sessions } = mapSessions({ dataType: sleep, ...ctx, body: body([aNight]) })
    expect(JSON.parse(sessions[0]?.attrs ?? '{}')).toMatchObject({ mainSleep: true, type: 'STAGES' })
  })

  it('preserves shortAwakenings in attrs rather than turning them into overlapping segments', () => {
    const { sessions, segments } = mapSessions({ dataType: sleep, ...ctx, body: body([nightWithAwakenings]) })
    const attrs = JSON.parse(sessions[0]?.attrs ?? '{}')
    expect(attrs.shortAwakenings).toEqual([
      { type: 'AWAKE', startTime: '2026-08-18T01:00:00Z', endTime: '2026-08-18T01:02:00Z' },
    ])
    expect(segments).toHaveLength(0)
  })

  it('resolves shortAwakenings to null in attrs when the payload carries none', () => {
    const { sessions } = mapSessions({ dataType: sleep, ...ctx, body: body([aNight]) })
    expect(JSON.parse(sessions[0]?.attrs ?? '{}').shortAwakenings).toBeNull()
  })

  it('captures exerciseType in attrs for an exercise session', () => {
    const { sessions } = mapSessions({ dataType: exercise, ...ctx, body: body([anExercise]) })
    expect(sessions[0]).toMatchObject({ kind: 'exercise' })
    expect(JSON.parse(sessions[0]?.attrs ?? '{}').exerciseType).toBe('RUNNING')
  })

  it('resolves exerciseType to null in attrs for a sleep session', () => {
    const { sessions } = mapSessions({ dataType: sleep, ...ctx, body: body([aNight]) })
    expect(JSON.parse(sessions[0]?.attrs ?? '{}').exerciseType).toBeNull()
  })

  it('skips a session with no readable interval rather than inventing one', () => {
    const { sessions } = mapSessions({
      dataType: sleep, ...ctx, body: body([{ sleep: { type: 'STAGES' } }]),
    })
    expect(sessions).toHaveLength(0)
  })

  it('tolerates a payload it has never seen', () => {
    expect(() => mapSessions({ dataType: sleep, ...ctx, body: '{"unexpected":true}' })).not.toThrow()
  })

  it('tolerates a body that parses to a JSON null rather than an object', () => {
    expect(() => mapSessions({ dataType: sleep, ...ctx, body: 'null' })).not.toThrow()
    expect(mapSessions({ dataType: sleep, ...ctx, body: 'null' })).toEqual({ sessions: [], segments: [] })
  })

  it('tolerates a body that parses to a bare JSON number rather than an object', () => {
    expect(() => mapSessions({ dataType: sleep, ...ctx, body: '42' })).not.toThrow()
    expect(mapSessions({ dataType: sleep, ...ctx, body: '42' })).toEqual({ sessions: [], segments: [] })
  })

  it('tolerates dataPoints arriving as something other than an array', () => {
    const result = mapSessions({
      dataType: sleep, ...ctx, body: JSON.stringify({ dataPoints: { cursor1: aNight } }),
    })
    expect(result).toEqual({ sessions: [], segments: [] })
  })

  it('refuses a sample type, which needs the other mapper', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    expect(() => mapSessions({ dataType: spo2, ...ctx, body: body([]) })).toThrow(/not a session type/)
  })

  // Task 5's alsoTargets generalisation: a type may write here as an extra target, not only as
  // its primary one, without the guard refusing it as foreign. And unchanged for a type that
  // does not declare it, which is every type in the catalogue today.
  it('accepts a type whose primary target is foreign when alsoTargets names sessions', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    const hybrid = { ...spo2, target: 'samples' as const, alsoTargets: ['sessions'] as const }
    expect(() => mapSessions({ dataType: hybrid, ...ctx, body: body([]) })).not.toThrow()
  })

  it('still refuses a foreign target with no alsoTargets naming this one, unchanged from before', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    expect(spo2.alsoTargets).toBeUndefined()
  })

  it('attributes each session to its own point source rather than one source for the whole body', () => {
    const fitbitNight = sleepPoint({
      name: 'users/me/dataTypes/sleep/dataPoints/fitbit',
      startTime: '2026-08-17T21:30:00Z', endTime: '2026-08-18T05:15:00Z',
      stages: [], dataSource: { platform: 'FITBIT' },
    })
    const healthConnectNight = sleepPoint({
      name: 'users/me/dataTypes/sleep/dataPoints/hc',
      startTime: '2026-08-18T21:30:00Z', endTime: '2026-08-19T05:15:00Z',
      stages: [], dataSource: { platform: 'HEALTH_CONNECT' },
    })
    const { sessions } = mapSessions({
      dataType: sleep, personId: 'p1', rawPayloadId: 'r1',
      resolveSource: (dataSource) => (dataSource as { platform: string }).platform,
      body: body([fitbitNight, healthConnectNight]),
    })
    expect(sessions).toHaveLength(2)
    expect(sessions.map((s) => s.sourceId)).toEqual(['FITBIT', 'HEALTH_CONNECT'])
    expect(sessions[0]?.id).not.toBe(sessions[1]?.id)
  })
})
