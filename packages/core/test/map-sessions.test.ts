import { describe, expect, it } from 'vitest'
import { mapSessions } from '../src/api/mapSessions.ts'
import { dataTypeById } from '../src/api/catalogue.ts'
import { sleepPoint, body } from '../src/testing/payloads.ts'

const ctx = { personId: 'p1', sourceId: 's1', rawPayloadId: 'r1' }
const sleep = dataTypeById('sleep')!

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
    const crossing = sleepPoint({
      startTime: '2026-10-24T22:00:00Z', endTime: '2026-10-25T06:00:00Z', stages: [],
    })
    const { sessions } = mapSessions({ dataType: sleep, ...ctx, body: body([crossing]) })
    expect(sessions[0]).toHaveProperty('startOffsetMinutes')
    expect(sessions[0]).toHaveProperty('endOffsetMinutes')
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

  it('skips a session with no readable interval rather than inventing one', () => {
    const { sessions } = mapSessions({
      dataType: sleep, ...ctx, body: body([{ sleep: { type: 'STAGES' } }]),
    })
    expect(sessions).toHaveLength(0)
  })

  it('tolerates a payload it has never seen', () => {
    expect(() => mapSessions({ dataType: sleep, ...ctx, body: '{"unexpected":true}' })).not.toThrow()
  })

  it('refuses a sample type, which needs the other mapper', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    expect(() => mapSessions({ dataType: spo2, ...ctx, body: body([]) })).toThrow(/not a session type/)
  })
})
