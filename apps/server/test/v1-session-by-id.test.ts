import { describe, it, expect, afterEach } from 'vitest'
import { insertSample, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const OFFSET_MINUTES = 120

async function get(h: Harness, token: string, path: string, personId = 'p1') {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/p/${personId}${path}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

function seedSource(h: Harness, personId: string, sourceId: string): void {
  h.app.haelan.instance.db.insert(schema.sources).values({
    id: sourceId, personId, externalId: sourceId, displayName: sourceId,
    kind: 'device', createdAtMs: 0,
  }).onConflictDoNothing().run()
}

function seedWorkout(h: Harness, input: {
  id: string, personId?: string, sourceId?: string, attrs?: unknown,
}): void {
  const personId = input.personId ?? 'p1'
  const sourceId = input.sourceId ?? 'watch'
  seedSource(h, personId, sourceId)
  const startMs = Date.parse('2026-08-18T09:00:00Z') - OFFSET_MINUTES * 60_000
  h.app.haelan.instance.db.insert(schema.sessions).values({
    id: input.id, personId, sourceId, kind: 'exercise', externalId: input.id,
    startMs, startOffsetMinutes: OFFSET_MINUTES,
    endMs: startMs + 3_600_000, endOffsetMinutes: OFFSET_MINUTES,
    localDate: '2026-08-18',
    attrs: JSON.stringify(input.attrs ?? { exerciseType: 'RUNNING' }),
    rawPayloadId: null,
  }).run()
}

// seedWorkout always writes an exercise row. This one writes a row of whichever of the three
// kinds the table holds, so a test can vary the kind and nothing else.
function seedOfKind(h: Harness, input: { id: string, kind: 'sleep' | 'exercise' | 'ecg' }): void {
  seedSource(h, 'p1', 'watch')
  h.app.haelan.instance.db.insert(schema.sessions).values({
    id: input.id, personId: 'p1', sourceId: 'watch', kind: input.kind, externalId: input.id,
    startMs: 1, startOffsetMinutes: OFFSET_MINUTES, endMs: 2, endOffsetMinutes: OFFSET_MINUTES,
    localDate: '2026-08-18', attrs: '{}', rawPayloadId: null,
  }).run()
}

describe('GET /sessions/:sessionId', () => {
  it('answers the session itself, not a one-item list', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedWorkout(harness, {
      id: 'run1',
      attrs: { exerciseType: 'RUNNING', displayName: 'Evening Run', splits: [{ splitType: 'DISTANCE' }] },
    })

    const res = await get(harness, token, '/sessions/run1')

    expect(res.statusCode).toBe(200)
    const session = res.json()
    // The object directly. A detail read has exactly one answer, so an items array would make
    // every caller index into a list of one before it could use anything.
    expect(session.id).toBe('run1')
    expect(session.sourceId).toBe('watch')
    expect(session.localDate).toBe('2026-08-18')
    expect(session.excluded).toBe(false)
    // attrs reaches the client parsed and whole, splits included: this route is the only reason
    // the mapper was widened.
    expect(session.attrs.displayName).toBe('Evening Run')
    expect(session.attrs.splits).toEqual([{ splitType: 'DISTANCE' }])
  })

  it('answers 404 in the envelope shape for an id that names nothing', async () => {
    harness = await withServer(); const token = await harness.signIn()

    const res = await get(harness, token, '/sessions/nope')

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({
      error: { kind: 'not_found', code: 'no_such_session', message: "no session 'nope'" },
    })
  })

  it("answers 404, not 403, for another person's session id", async () => {
    harness = await withServer(); const token = await harness.signIn()
    await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
    seedWorkout(harness, { id: 'their-run', personId: 'p2', sourceId: 'their-watch' })

    // The row exists, under a path this caller is entitled to ask about. 403 would confirm the id
    // is real, which is the one thing this caller must not learn. The table-driven suite in
    // v1-isolation.test.ts cannot express this case: its path(personId) builds a path for one
    // person, and this is p1's own path carrying p2's id.
    const res = await get(harness, token, '/sessions/their-run')

    expect(res.statusCode).toBe(404)
    // The full envelope, byte for byte the same shape the nonexistent-id case above asserts, with
    // only the id substituted: kind, code and message must all fail to distinguish "no such id"
    // from "somebody else's id", not merely kind. A regression that kept kind: 'not_found' but
    // changed code to something like 'not_your_session', or wrote a message admitting the row
    // exists, would still pass a kind-only check and would still be the exact leak this route
    // exists to prevent.
    expect(res.json()).toEqual({
      error: { kind: 'not_found', code: 'no_such_session', message: "no session 'their-run'" },
    })
    // Nothing about the other person's session leaks into the message.
    expect(res.body).not.toContain('their-watch')
  })

  it('carries the exclusion and its reason', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedWorkout(harness, { id: 'run1' })
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/p/p1/overrides',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        scope: 'session',
        targetKey: JSON.stringify({ session: 'run1' }),
        action: 'exclude',
        reason: 'forgot to stop the timer',
      },
    })

    const session = (await get(harness, token, '/sessions/run1')).json()
    expect(session.excluded).toBe(true)
    expect(session.excludeReason).toBe('forgot to stop the timer')
  })

  it('sets a weak ETag and answers 304 when it is sent back', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedWorkout(harness, { id: 'run1' })

    const first = await get(harness, token, '/sessions/run1')
    const etag = first.headers.etag
    expect(etag).toBeDefined()

    const second = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/p/p1/sessions/run1',
      headers: { authorization: `Bearer ${token}`, 'if-none-match': String(etag) },
    })
    expect(second.statusCode).toBe(304)
  })

  it('answers a sleep session too, since an id names one row across the two kinds it serves', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedOfKind(harness, { id: 'night1', kind: 'sleep' })

    expect((await get(harness, token, '/sessions/night1')).json().id).toBe('night1')
  })

  it('carries the cardio load beside the session', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedWorkout(harness, {
      id: 'run1',
      attrs: {
        exerciseType: 'RUNNING',
        // 600s each -> 10 minutes each -> Edwards = 1*10 + 2*10 + 3*10 + 4*10 = 100.
        metricsSummary: {
          heartRateZoneDurations: {
            lightTime: '600s', moderateTime: '600s', vigorousTime: '600s', peakTime: '600s',
          },
        },
      },
    })

    const session = (await get(harness, token, '/sessions/run1')).json()

    // The whole object, not just edwards: banister stays null with no heart rate profile seeded,
    // and a load folded into `session` rather than carried beside it would still pass a
    // one-field check.
    expect(session.cardioLoad).toEqual({ edwards: 100, banister: null, banisterBasis: null })
  })

  it('carries autoSplits and laps beside the session, filled from the trace where the provider left them null', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const startMs = Date.parse('2026-08-18T09:00:00Z') - OFFSET_MINUTES * 60_000
    seedWorkout(harness, {
      id: 'run1',
      attrs: {
        exerciseType: 'RUNNING',
        splits: [{
          startTime: new Date(startMs).toISOString(),
          endTime: new Date(startMs + 5 * 60_000).toISOString(),
          splitType: 'DISTANCE', activeDuration: '300s',
          metricsSummary: { distanceMillimeters: 1_000_000, averagePaceSecondsPerMeter: 0.3 },
          // No averageHeartRateBeatsPerMinute: the provider left this split's own heart rate null.
        }],
      },
    })
    // One reading a minute across the split's window, mean 170.
    for (let i = 0; i < 5; i += 1) {
      insertSample(harness.app.haelan.instance.db, {
        personId: 'p1', sourceId: 'watch', metric: 'heart_rate',
        utcMs: startMs + i * 60_000, tzOffsetMinutes: OFFSET_MINUTES, agg: 'mean', value: 170,
      })
    }

    const session = (await get(harness, token, '/sessions/run1')).json()

    expect(session.autoSplits).toHaveLength(1)
    expect(session.autoSplits[0].averageHeartRateBpm).toBe(170)
    expect(session.autoSplits[0].averageHeartRateBpmSource).toBe('trace')
    expect(session.laps).toEqual([])
  })

  it('answers 404 for an ecg id, in the same envelope as an id that names nothing', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedOfKind(harness, { id: 'ecg1', kind: 'ecg' })

    const res = await get(harness, token, '/sessions/ecg1')

    // The row is this person's and it exists. The list route refuses kind=ecg because nothing has
    // designed an ECG response, and readSession refuses it for the same reason, so the two agree.
    // The full envelope, not just the status: the 404 must carry the same code and the same
    // message an absent id gets, or "this id is an ECG" becomes a way to confirm an id is real -
    // the same leak the cross-person case above exists to prevent.
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({
      error: { kind: 'not_found', code: 'no_such_session', message: "no session 'ecg1'" },
    })
  })

  // Task 7: this route is the household's own read of their own session, the surface the export
  // principle names - "an export is the household asking for their own data, and getting less
  // than they own would be wrong" - unlike get_workout and sql_query, which keep coordinates out
  // on purpose. A regression here would mean Step 2's tool-layer exclusion had leaked backwards
  // into the one place coordinates belong.
  it('carries a route\'s coordinates, the one surface that deliberately does', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedWorkout(harness, { id: 'run1' })
    harness.app.haelan.instance.db.insert(schema.sessionRoutes).values({
      id: 'run1-route-0', sessionId: 'run1', ordinal: 0,
      atMs: Date.parse('2026-08-18T09:05:00Z'), latitude: 52.1, longitude: 4.3,
      altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
    }).run()

    const session = (await get(harness, token, '/sessions/run1')).json()

    expect(session.route).toEqual([{
      atMs: Date.parse('2026-08-18T09:05:00Z'), latitude: 52.1, longitude: 4.3,
      altitudeMetres: null, horizontalAccuracyMetres: null, verticalAccuracyMetres: null,
    }])
  })
})
