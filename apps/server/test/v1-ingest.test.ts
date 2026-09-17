import { describe, it, expect, afterEach } from 'vitest'
import { samplePoint, schema, sleepPoint } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'
import { rebuildIfNeeded } from '../src/rebuild.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// A mutating request is refused by the origin hook unless these two agree. Every POST below
// carries both, so a failure names the route's own reason rather than bad_origin.
const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }

const weightPoint = () => samplePoint({
  payloadKey: 'weight',
  valuePath: 'weightGrams',
  value: '80000',
  physicalTime: '2026-08-18T10:00:00Z',
})

async function ingest(token: string, path: string, payload: Record<string, unknown>) {
  if (!harness) throw new Error('no harness')
  return harness.app.inject({
    method: 'POST', url: path,
    headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    payload,
  })
}

interface NamedSource { id: string, externalId: string, displayName: string, kind: string }

/**
 * The person's sources, the way the dashboard's own names screen reads them, ordered by identity
 * so a test can assert the whole list rather than depend on the order the route happened to
 * return its rows in.
 */
async function sources(token: string): Promise<NamedSource[]> {
  if (!harness) throw new Error('no harness')
  const response = await harness.app.inject({
    method: 'GET', url: '/api/v1/p/p1/sources',
    headers: { authorization: `Bearer ${token}` },
  })
  expect(response.statusCode).toBe(200)
  const items = (response.json() as { items: NamedSource[] }).items
  return [...items].sort((a, b) => (a.externalId < b.externalId ? -1 : 1))
}

const namedSources = async (token: string) =>
  (await sources(token)).map(({ externalId, displayName, kind }) => ({ externalId, displayName, kind }))

describe('the companion ingest route', () => {
  it('archives, maps, writes and derives a companion upload', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const response = await ingest(token, '/api/v1/p/p1/ingest/weight', { dataPoints: [weightPoint()] })
    expect(response.statusCode).toBe(200)
    const created = response.json() as {
      payloadId: string, deduplicated: boolean, rowsWritten: number,
      affected: { from: string, to: string } | null, applied: boolean,
    }
    expect(created.deduplicated).toBe(false)
    expect(created.rowsWritten).toBe(1)
    expect(created.affected).toEqual({ from: '2026-08-18', to: '2026-08-18' })
    expect(created.applied).toBe(true)
    expect(typeof created.payloadId).toBe('string')

    // Derived, not merely queued: nothing else drains a companion-only person, so the queue
    // being empty is the proof the request did it rather than leaving it for a sync.
    expect(harness.app.haelan.instance.deriveQueue.size()).toBe(0)

    const series = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/p/p1/series?metric=weight&agg=last&from=2026-08-18&to=2026-08-18',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(series.statusCode).toBe(200)
    const points = (series.json() as { weight: { points: { localDate: string, value: number }[] } }).weight.points
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ localDate: '2026-08-18', value: 80000 })

    // The upload resolved to the companion source identity, not to the FITBIT dataSource
    // the test point itself carries: the uploading phone is the source, per-point identities
    // inside the payload are not resolved. Exactly one source exists afterwards.
    const sources = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/sources',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(sources.statusCode).toBe(200)
    const items = (sources.json() as { items: { externalId: string, displayName: string, kind: string }[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      externalId: 'HEALTH_CONNECT:com.haelan.android',
      displayName: 'com.haelan.android',
      kind: 'app',
    })
  })

  it('files two devices as two sources rather than one', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const fromDevice = (displayName: string) => ({
      dataPoints: [weightPoint()],
      dataSource: {
        platform: 'HEALTH_CONNECT',
        application: { packageName: 'com.haelan.android' },
        device: { displayName },
        recordingMethod: 'PASSIVELY_MEASURED',
      },
    })

    expect((await ingest(token, '/api/v1/p/p1/ingest/weight', fromDevice('Google Pixel Watch 3'))).statusCode).toBe(200)
    expect((await ingest(token, '/api/v1/p/p1/ingest/weight', fromDevice('Google Pixel 9 Pro'))).statusCode).toBe(200)

    // The whole list rather than two membership checks: what this test is about is that one
    // device did not fold into the other, and a "contains" would pass on a list where both
    // readings landed on a single row.
    expect(await namedSources(token)).toEqual([
      { externalId: 'HEALTH_CONNECT:Google Pixel 9 Pro', displayName: 'Google Pixel 9 Pro', kind: 'device' },
      { externalId: 'HEALTH_CONNECT:Google Pixel Watch 3', displayName: 'Google Pixel Watch 3', kind: 'device' },
    ])
  })

  // T6.1: pairing names a person, so two phones on two members never fold into one source,
  // even holding the same watch. The source side was already person scoped; this pins it
  // instead of taking it for granted, the way the two-devices test above pins device scoping.
  it('files one device under two persons as two sources rather than one', async () => {
    harness = await withServer()
    const admin = await harness.signIn()
    const added = await harness.addPerson({ id: 'p2', displayName: 'Bob', username: 'bob' })
    const bob = await harness.signIn('bob', 'a good long password')

    const fromSameWatch = {
      dataPoints: [weightPoint()],
      dataSource: {
        platform: 'HEALTH_CONNECT',
        application: { packageName: 'com.haelan.android' },
        device: { displayName: 'Google Pixel Watch 3' },
        recordingMethod: 'PASSIVELY_MEASURED',
      },
    }
    expect((await ingest(admin, '/api/v1/p/p1/ingest/weight', fromSameWatch)).statusCode).toBe(200)
    expect((await ingest(bob, `/api/v1/p/${added.personId}/ingest/weight`, fromSameWatch)).statusCode).toBe(200)

    const listFor = async (token: string, personId: string) => {
      if (!harness) throw new Error('no harness')
      const response = await harness.app.inject({
        method: 'GET', url: `/api/v1/p/${personId}/sources`,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.statusCode).toBe(200)
      return (response.json() as { items: NamedSource[] }).items
    }
    const p1sources = await listFor(admin, 'p1')
    const p2sources = await listFor(bob, added.personId)
    expect(p1sources).toHaveLength(1)
    expect(p2sources).toHaveLength(1)
    expect(p1sources[0]).toMatchObject({ displayName: 'Google Pixel Watch 3', kind: 'device' })
    expect(p2sources[0]).toMatchObject({ displayName: 'Google Pixel Watch 3', kind: 'device' })
    expect(p2sources[0]!.id).not.toBe(p1sources[0]!.id)

    // The control that proves this test discriminates: the same person uploading again
    // resolves the same source instead of minting a second row.
    expect((await ingest(admin, '/api/v1/p/p1/ingest/weight', fromSameWatch)).statusCode).toBe(200)
    expect(await listFor(admin, 'p1')).toHaveLength(1)
  })

  it('gives a reading somebody typed in a manual source of its own', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const typed = await ingest(token, '/api/v1/p/p1/ingest/weight', {
      dataPoints: [weightPoint()],
      dataSource: {
        platform: 'HEALTH_CONNECT',
        application: { packageName: 'com.haelan.android' },
        recordingMethod: 'MANUAL',
      },
    })
    expect(typed.statusCode).toBe(200)

    // No device, so the package names the source, and MANUAL is the whole of what makes it a
    // source somebody can exclude from a trend instead of the scale's own reading.
    expect(await namedSources(token)).toEqual([
      { externalId: 'HEALTH_CONNECT:com.haelan.android:MANUAL', displayName: 'com.haelan.android', kind: 'manual' },
    ])
  })

  // The pair that has to survive a rebuild. The archive is the only thing a replay reads, and the
  // companion app names its source once per request and never inside a point, so a body archived
  // without that identity replays every row under `unknown`, silently, the first time somebody
  // moves MAPPING_VERSION.
  it('replays a companion page to the source the live write filed it under', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const written = await ingest(token, '/api/v1/p/p1/ingest/weight', {
      dataPoints: [{
        weight: {
          sampleTime: { physicalTime: '2026-08-18T10:00:00Z', utcOffset: '7200s' },
          weightGrams: '80000',
        },
      }],
      dataSource: {
        platform: 'HEALTH_CONNECT',
        application: { packageName: 'com.haelan.android.debug' },
        device: { displayName: 'Google Pixel Watch 3' },
        recordingMethod: 'PASSIVELY_MEASURED',
      },
    })
    expect(written.statusCode).toBe(200)

    const before = await sources(token)
    expect(before.map((s) => s.externalId)).toEqual(['HEALTH_CONNECT:Google Pixel Watch 3'])
    expect(before.map((s) => s.kind)).toEqual(['device'])

    // What every person's stamp looks like the moment MAPPING_VERSION moves: cleared, which is
    // what the boot rebuild reads before it decides to replay somebody.
    harness.app.haelan.instance.db.update(schema.people).set({
      builtMappingVersion: null, builtDerivationVersion: null,
    }).run()
    await rebuildIfNeeded({ instance: harness.app.haelan.instance, nowMs: () => Date.now(), log: () => {} })

    expect(await sources(token)).toEqual(before)
  })

  it('a repeated upload deduplicates instead of doubling', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const payload = { dataPoints: [weightPoint()] }

    const first = await ingest(token, '/api/v1/p/p1/ingest/weight', payload)
    expect(first.statusCode).toBe(200)
    const second = await ingest(token, '/api/v1/p/p1/ingest/weight', payload)
    expect(second.statusCode).toBe(200)
    const repeated = second.json() as { payloadId: string, deduplicated: boolean, rowsWritten: number }
    expect(repeated.deduplicated).toBe(true)
    expect(repeated.payloadId).toBe((first.json() as { payloadId: string }).payloadId)
    expect(repeated.rowsWritten).toBe(1)

    const series = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/p/p1/series?metric=weight&agg=last&from=2026-08-18&to=2026-08-18',
      headers: { authorization: `Bearer ${token}` },
    })
    const points = (series.json() as { weight: { points: unknown[] } }).weight.points
    expect(points).toHaveLength(1)
  })

  it('answers 401 with no session at all, before touching anything', async () => {
    harness = await withServer()
    await harness.signIn()
    const response = await harness.app.inject({
      method: 'POST', url: '/api/v1/p/p1/ingest/weight',
      payload: { dataPoints: [weightPoint()] },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { kind: 'unauthorized', code: 'no_session' } })
  })

  /**
   * T3.4's decision, held here so it cannot be quietly reversed into the refusal it was once
   * assumed to be. The two controls that look alike are not the same decision: the exclusion
   * list answers "what does this instance go and fetch", which is what the screen that writes
   * it says ("Turning one off stops fetching it"), and what the phone pushes is the phone's
   * own switches. Excluding a type therefore says nothing about a reading the phone chose to
   * send, and an ingest route that refused or silently dropped it would be enforcing a
   * person's Google preference over their own upload.
   */
  it('writes a type the person excluded, because the exclusion governs fetching and not the phone', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    harness.app.haelan.stores.excludedDataTypes.setFor({
      personId: 'p1', dataTypeIds: ['weight'], nowMs: harness.clock.nowMs,
    })

    const response = await ingest(token, '/api/v1/p/p1/ingest/weight', { dataPoints: [weightPoint()] })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ deduplicated: false, rowsWritten: 1, applied: true })

    const series = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/p/p1/series?metric=weight&agg=last&from=2026-08-18&to=2026-08-18',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(series.statusCode).toBe(200)
    const points = (series.json() as { weight: { points: { localDate: string, value: number }[] } }).weight.points
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ localDate: '2026-08-18', value: 80000 })
  })

  it('refuses a write against another person, and leaves their data alone', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })

    const written = await ingest(token, '/api/v1/p/p2/ingest/weight', { dataPoints: [weightPoint()] })
    expect(written.statusCode).toBe(403)
    expect(written.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })

    // Read back through the other person's own session: a route that acted before refusing
    // would have left a row this status-only assertion could never see.
    const otherToken = await harness.signIn('other', 'a good long password')
    const series = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/p/p2/series?metric=weight&agg=last&from=2026-08-18&to=2026-08-18',
      headers: { authorization: `Bearer ${otherToken}` },
    })
    expect(series.statusCode).toBe(200)
    expect((series.json() as { weight: { points: unknown[] } }).weight.points).toEqual([])
  })

  it('refuses what it cannot honestly ingest', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    // No such data type.
    const unknown = await ingest(token, '/api/v1/p/p1/ingest/nope', { dataPoints: [weightPoint()] })
    expect(unknown.statusCode).toBe(400)

    // A real type, but sessions backed: covered by the session cases below, which is why
    // asking for it here moved there rather than staying as a refusal.
    const sleepAsSample = await ingest(token, '/api/v1/p/p1/ingest/sleep', { dataPoints: [weightPoint()] })
    expect(sleepAsSample.statusCode).toBe(200)
    expect((sleepAsSample.json() as { rowsWritten: number }).rowsWritten).toBe(0)

    // No array, an empty one, and one no request should ever carry.
    const missing = await ingest(token, '/api/v1/p/p1/ingest/weight', {})
    expect(missing.statusCode).toBe(400)
    const empty = await ingest(token, '/api/v1/p/p1/ingest/weight', { dataPoints: [] })
    expect(empty.statusCode).toBe(400)
    const huge = await ingest(token, '/api/v1/p/p1/ingest/weight', {
      dataPoints: Array.from({ length: 10_001 }, () => ({})),
    })
    expect(huge.statusCode).toBe(400)
  })

  it('refuses types no single writer can carry', async () => {    harness = await withServer()
    const token = await harness.signIn()
    const payload = { dataPoints: [weightPoint()] }

    // Electrocardiogram fans out to three tables; the sessions writer alone would drop two
    // of them while answering 200.
    const ecg = await ingest(token, '/api/v1/p/p1/ingest/electrocardiogram', payload)
    expect(ecg.statusCode).toBe(400)

    // Observations backed, with no writer at all yet.
    const moods = await ingest(token, '/api/v1/p/p1/ingest/moods', payload)
    expect(moods.statusCode).toBe(400)

    // Catalogued but never fetched: food has no clock to build a window from.
    const food = await ingest(token, '/api/v1/p/p1/ingest/food', payload)
    expect(food.statusCode).toBe(400)
  })
})

const sleepPointFor = () => sleepPoint({
  startTime: '2026-08-17T21:30:00Z',
  endTime: '2026-08-18T05:15:00Z',
  stages: [
    { type: 'LIGHT', startTime: '2026-08-17T21:30:00Z', endTime: '2026-08-17T22:30:00Z' },
    { type: 'DEEP', startTime: '2026-08-17T22:30:00Z', endTime: '2026-08-18T00:30:00Z' },
    { type: 'REM', startTime: '2026-08-18T00:30:00Z', endTime: '2026-08-18T02:00:00Z' },
    { type: 'AWAKE', startTime: '2026-08-18T02:00:00Z', endTime: '2026-08-18T02:10:00Z' },
    { type: 'LIGHT', startTime: '2026-08-18T02:10:00Z', endTime: '2026-08-18T05:15:00Z' },
  ],
})

const exercisePoint = () => ({
  name: 'users/me/dataTypes/exercise/dataPoints/run1',
  dataSource: { platform: 'HEALTH_CONNECT', recordingMethod: 'ACTIVELY_MEASURED' },
  exercise: {
    interval: {
      startTime: '2026-08-18T06:00:00Z', startUtcOffset: '7200s',
      endTime: '2026-08-18T06:30:00Z', endUtcOffset: '7200s',
    },
    exerciseType: 'RUNNING',
  },
})

describe('the companion ingest route for sessions', () => {
  it('archives, maps, writes and derives an uploaded night', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const response = await ingest(token, '/api/v1/p/p1/ingest/sleep', { dataPoints: [sleepPointFor()] })
    expect(response.statusCode).toBe(200)
    const created = response.json() as {
      payloadId: string, deduplicated: boolean, rowsWritten: number,
      affected: { from: string, to: string } | null, applied: boolean,
    }
    expect(created.deduplicated).toBe(false)
    expect(created.rowsWritten).toBe(1)
    // Filed under the wake date, the way every sleep session is.
    expect(created.affected).toEqual({ from: '2026-08-18', to: '2026-08-18' })
    expect(created.applied).toBe(true)
    expect(harness.app.haelan.instance.deriveQueue.size()).toBe(0)

    const nights = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/sleep/nights?from=2026-08-18&to=2026-08-18',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(nights.statusCode).toBe(200)
    const items = (nights.json() as { items: { localDate: string, segments: unknown[] }[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]?.localDate).toBe('2026-08-18')
    expect(items[0]?.segments).toHaveLength(5)
  })

  it('a repeated night deduplicates instead of doubling', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const payload = { dataPoints: [sleepPointFor()] }

    const first = await ingest(token, '/api/v1/p/p1/ingest/sleep', payload)
    expect(first.statusCode).toBe(200)
    const second = await ingest(token, '/api/v1/p/p1/ingest/sleep', payload)
    expect(second.statusCode).toBe(200)
    const repeated = second.json() as { payloadId: string, deduplicated: boolean }
    expect(repeated.deduplicated).toBe(true)
    expect(repeated.payloadId).toBe((first.json() as { payloadId: string }).payloadId)

    const nights = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/sleep/nights?from=2026-08-18&to=2026-08-18',
      headers: { authorization: `Bearer ${token}` },
    })
    const items = (nights.json() as { items: unknown[] }).items
    expect(items).toHaveLength(1)
  })

  it('archives, maps and lists an uploaded workout', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const response = await ingest(token, '/api/v1/p/p1/ingest/exercise', { dataPoints: [exercisePoint()] })
    expect(response.statusCode).toBe(200)
    const created = response.json() as { rowsWritten: number, applied: boolean }
    expect(created.rowsWritten).toBe(1)
    expect(created.applied).toBe(true)

    const sessions = await harness.app.inject({
      method: 'GET', url: '/api/v1/p/p1/sessions?kind=exercise&from=2026-08-18&to=2026-08-18',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(sessions.statusCode).toBe(200)
    const items = (sessions.json() as { items: { localDate: string, attrs: { exerciseType: string } }[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]?.localDate).toBe('2026-08-18')
    expect(items[0]?.attrs.exerciseType).toBe('RUNNING')
  })

  // The route's contract says ten thousand points, and ten thousand points do not fit the one
  // mebibyte Fastify allows by default: the app found this as a 413 on a real sync, on a body
  // the route itself calls valid. The assertion on the body size is what keeps this test
  // meaning something if that default ever grows.
  it('accepts a body larger than the default limit, because its own contract promises one', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const base = Date.UTC(2026, 0, 1)
    const dataPoints = Array.from({ length: 10_000 }, (_, index) => samplePoint({
      payloadKey: 'weight',
      valuePath: 'weightGrams',
      value: '80000',
      physicalTime: new Date(base + index * 60_000).toISOString(),
    }))
    const payload = { dataPoints }
    expect(JSON.stringify(payload).length).toBeGreaterThan(1024 * 1024)

    const response = await ingest(token, '/api/v1/p/p1/ingest/weight', payload)
    expect(response.statusCode).toBe(200)
    expect((response.json() as { rowsWritten: number }).rowsWritten).toBe(10_000)
  })

  it('refuses one point more than the maximum rather than letting it through', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const base = Date.UTC(2026, 0, 1)
    const dataPoints = Array.from({ length: 10_001 }, (_, index) => samplePoint({
      payloadKey: 'weight',
      valuePath: 'weightGrams',
      value: '80000',
      physicalTime: new Date(base + index * 60_000).toISOString(),
    }))

    const response = await ingest(token, '/api/v1/p/p1/ingest/weight', { dataPoints })
    expect(response.statusCode).toBe(400)
  })
})
