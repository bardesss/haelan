import { describe, it, expect, afterEach } from 'vitest'
import { schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// A mutating request is refused by the origin hook (routes/auth.ts) unless the two agree, so
// every write below carries both, the same as v1-annotations.test.ts's own ORIGIN.
const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }

const SEED_KINDS = ['illness', 'travel', 'alcohol', 'medication', 'injury', 'caffeine']

async function req(
  h: Harness, token: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, payload?: object,
) {
  return h.app.inject({
    method, url: `/api/v1/p/p1${path}`,
    headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    payload,
  })
}

async function get(h: Harness, token: string, path: string, extraHeaders: Record<string, string> = {}) {
  return h.app.inject({
    method: 'GET', url: `/api/v1/p/p1${path}`,
    headers: { authorization: `Bearer ${token}`, ...extraHeaders },
  })
}

/**
 * A night whose bedtime and wake are given directly, so a test can plant one that ends on a
 * specific local date without depending on the harness clock the way v1-isolation.test.ts's own
 * seedNight does. Modelled on that helper (same schema rows, same fixed sourceId shape) but
 * parameterized, since this file's cases need nights on the 25th-into-the-26th and no night at
 * all, neither of which that helper's clock-relative version can produce.
 */
function seedNight(h: Harness, input: {
  personId: string, sourceId: string, startMs: number, endMs: number, localDate: string,
}): void {
  h.app.haelan.instance.db.insert(schema.sources).values({
    id: input.sourceId, personId: input.personId, externalId: input.sourceId, displayName: input.sourceId,
    kind: 'device', createdAtMs: 0,
  }).run()
  const id = `${input.personId}-${input.localDate}-night`
  h.app.haelan.instance.db.insert(schema.sessions).values({
    id, personId: input.personId, sourceId: input.sourceId, kind: 'sleep', externalId: id,
    startMs: input.startMs, startOffsetMinutes: 120, endMs: input.endMs, endOffsetMinutes: 120,
    localDate: input.localDate, attrs: JSON.stringify({}), rawPayloadId: null,
  }).run()
}

// 15:00 in Europe/Amsterdam (every harness person's zone), so p1's "today" is 2026-09-26
// throughout this file.
const NOW_MS = Date.parse('2026-09-26T13:00:00Z')

describe('GET/PUT /quick-log/presets', () => {
  it('answers the six seed kinds for a person who never saved', async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    const reply = await get(harness, token, '/quick-log/presets')
    expect(reply.statusCode).toBe(200)
    expect(reply.json().kinds).toEqual(SEED_KINDS)
  })

  it('saves a trimmed list and reads it back', async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    const written = await req(harness, token, 'PUT', '/quick-log/presets', { kinds: [' sauna', 'alcohol'] })
    expect(written.statusCode).toBe(200)
    expect(written.json().kinds).toEqual(['sauna', 'alcohol'])
    expect((await get(harness, token, '/quick-log/presets')).json().kinds).toEqual(['sauna', 'alcohol'])
  })

  it('answers 400 whose message contains repeats for a case-insensitive duplicate', async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    const written = await req(harness, token, 'PUT', '/quick-log/presets', { kinds: ['a', 'A'] })
    expect(written.statusCode).toBe(400)
    expect(written.json().error.message).toContain('repeats')
  })

  it('reads back an empty list once saved empty', async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    const written = await req(harness, token, 'PUT', '/quick-log/presets', { kinds: [] })
    expect(written.statusCode).toBe(200)
    expect(written.json().kinds).toEqual([])
    expect((await get(harness, token, '/quick-log/presets')).json().kinds).toEqual([])
  })
})

describe('POST /quick-log', () => {
  it("logs an event for today, started now, with today's own localDate", async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    const written = await req(harness, token, 'POST', '/quick-log', { kind: 'caffeine', day: '2026-09-26' })
    expect(written.statusCode).toBe(200)
    const body = written.json()
    expect(body.startedAtMs).toBe(NOW_MS)
    expect(body.startedAtOffsetMinutes).toBe(120)
    expect(body.localDate).toBe('2026-09-26')

    const list = await get(harness, token, '/events?from=2026-09-26&to=2026-09-26')
    expect(list.json().items).toHaveLength(1)
    expect(list.json().items[0].id).toBe(body.id)
  })

  it('files a past day\'s tap an hour before the bedtime of the night that followed it', async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    // 23:30 local on the 25th, filed under 2026-09-26: mapSessions.ts:55, a night belongs to the
    // morning it ended in, so the night that followed day 2026-09-25 is the one filed on the 26th.
    const bedtimeMs = Date.parse('2026-09-25T21:30:00Z')
    const wakeMs = Date.parse('2026-09-26T04:30:00Z')
    seedNight(harness, {
      personId: 'p1', sourceId: 'watch', startMs: bedtimeMs, endMs: wakeMs, localDate: '2026-09-26',
    })

    const written = await req(harness, token, 'POST', '/quick-log', { kind: 'alcohol', day: '2026-09-25' })
    expect(written.statusCode).toBe(200)
    expect(written.json().startedAtMs).toBe(bedtimeMs - 3_600_000)
  })

  it('answers 21:00 local on a past day with no night that followed it', async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    const written = await req(harness, token, 'POST', '/quick-log', { kind: 'illness', day: '2026-09-24' })
    expect(written.statusCode).toBe(200)
    // 21:00 local on the 24th, UTC+2.
    expect(written.json().startedAtMs).toBe(Date.parse('2026-09-24T19:00:00Z'))
  })

  it('refuses a day after today, an empty kind, and a malformed day', async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    const future = await req(harness, token, 'POST', '/quick-log', { kind: 'caffeine', day: '2026-09-27' })
    expect(future.statusCode).toBe(400)
    const emptyKind = await req(harness, token, 'POST', '/quick-log', { kind: '', day: '2026-09-26' })
    expect(emptyKind.statusCode).toBe(400)
    const badDay = await req(harness, token, 'POST', '/quick-log', { kind: 'caffeine', day: 'nope' })
    expect(badDay.statusCode).toBe(400)
    // Names `day`, the body field the caller actually sent, not `localDate` - a name that appears
    // nowhere in this request and would send a reader looking at the wrong field.
    expect(badDay.json().error.message).toContain('day')
    expect(badDay.json().error.message).not.toContain('localDate')
  })

})

describe('moods', () => {
  it('saves a score, lists it in range, refuses a future date, and deletes it', async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()

    const written = await req(harness, token, 'PUT', '/moods/2026-09-26', { score: 4 })
    expect(written.statusCode).toBe(200)
    expect(written.json()).toEqual({ localDate: '2026-09-26', score: 4 })

    const list = await get(harness, token, '/moods?from=2026-09-01&to=2026-09-30')
    expect(list.json().items).toMatchObject([{ localDate: '2026-09-26', score: 4 }])

    const future = await req(harness, token, 'PUT', '/moods/2026-09-27', { score: 3 })
    expect(future.statusCode).toBe(400)

    const removed = await req(harness, token, 'DELETE', '/moods/2026-09-26')
    expect(removed.statusCode).toBe(200)
    expect(removed.json()).toEqual({ localDate: '2026-09-26' })
    const after = await get(harness, token, '/moods?from=2026-09-01&to=2026-09-30')
    expect(after.json().items).toEqual([])
  })

  // The route's own pre-check, not the store's: this exact message is what the route's own
  // `typeof body.score !== 'number'` branch throws, before the value ever reaches MoodStore.put.
  // Deleting that branch and falling through to the store leaves this test red (the store passes
  // a non-number straight to Number.isInteger and throws the same wording as the case below).
  it('answers 400 with the exact "score must be a number" message for a non-number score', async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    const written = await req(harness, token, 'PUT', '/moods/2026-09-26', { score: '4' })
    expect(written.statusCode).toBe(400)
    expect(written.json().error.message).toBe('score must be a number')
  })

  // MoodStore.put's own message, for an in-range-type value the route's own pre-check lets
  // through: a real number that is merely out of range or non-integer is the store's problem to
  // name, not the route's.
  it('answers 400 with the store\'s own message for a score out of range', async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    const written = await req(harness, token, 'PUT', '/moods/2026-09-26', { score: 6 })
    expect(written.statusCode).toBe(400)
    expect(written.json().error.message).toBe('score must be an integer from 1 to 5')
  })

  it('answers 400 for a malformed date on DELETE', async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    const removed = await req(harness, token, 'DELETE', '/moods/not-a-date')
    expect(removed.statusCode).toBe(400)
  })
})

describe('GET /quick-log/day/:localDate', () => {
  it("answers the day's presets, mood, counts and note, and refuses a future date", async () => {
    harness = await withServer(); harness.clock.nowMs = NOW_MS
    const token = await harness.signIn()
    await req(harness, token, 'POST', '/quick-log', { kind: 'caffeine', day: '2026-09-26' })
    await req(harness, token, 'PUT', '/moods/2026-09-26', { score: 4 })
    await req(harness, token, 'PUT', '/notes/2026-09-26', { body: 'late dinner' })

    const body = (await get(harness, token, '/quick-log/day/2026-09-26')).json()
    expect(body).toEqual({
      presets: SEED_KINDS, mood: 4, counts: { caffeine: 1 }, note: 'late dinner', today: '2026-09-26',
    })
    // A past day's log still names the person's real today, not the day it is for.
    expect((await get(harness, token, '/quick-log/day/2026-09-20')).json().today).toBe('2026-09-26')

    const future = await get(harness, token, '/quick-log/day/2026-09-27')
    expect(future.statusCode).toBe(400)
  })
})
