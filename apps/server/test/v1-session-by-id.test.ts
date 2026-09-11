import { describe, it, expect, afterEach } from 'vitest'
import { schema } from '@haelan/core'
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

  it('answers a sleep session too, since an id names one row across both kinds', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSource(harness, 'p1', 'watch')
    harness.app.haelan.instance.db.insert(schema.sessions).values({
      id: 'night1', personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: 'night1',
      startMs: 1, startOffsetMinutes: OFFSET_MINUTES, endMs: 2, endOffsetMinutes: OFFSET_MINUTES,
      localDate: '2026-08-18', attrs: '{}', rawPayloadId: null,
    }).run()

    expect((await get(harness, token, '/sessions/night1')).json().id).toBe('night1')
  })
})
