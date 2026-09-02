import { describe, it, expect, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// A mutating request is refused by the origin hook (routes/auth.ts) unless the two agree, so
// every write below carries both. A test that forgot one would fail on a 403 that says nothing
// about what it was written to check.
const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }

async function putNote(h: Harness, token: string, localDate: string, body: string) {
  return h.app.inject({
    method: 'PUT', url: `/api/v1/p/p1/notes/${localDate}`,
    headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    payload: { body },
  })
}

async function postEvent(
  h: Harness, token: string, input: { kind: string, startedAtMs: number, startedAtOffsetMinutes?: number },
) {
  return h.app.inject({
    method: 'POST', url: '/api/v1/p/p1/events',
    headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    payload: input,
  })
}

/**
 * Writes an override straight through the store rather than the HTTP route: the route also
 * drains derivation, which these read-route tests have no interest in, and a day_metric target
 * needs no sample or session row to exist first, so the store call alone is enough to seed one.
 */
function putOverride(h: Harness, localDate: string, metric: string): string {
  return h.app.haelan.instance.overrides.put({
    personId: 'p1', scope: 'day_metric', targetKey: JSON.stringify({ localDate, metric }),
    action: 'exclude', reason: 'test fixture', nowMs: h.clock.nowMs,
  })
}

/**
 * `get` rather than `h.app.inject` inline: this file's GET tests need to attach `if-none-match`
 * the same way every write above attaches its own headers, and a fourth copy of that object
 * literal is the kind of drift `requireString`'s own shared home elsewhere in this codebase
 * exists to avoid.
 */
async function get(h: Harness, token: string, path: string, extraHeaders: Record<string, string> = {}) {
  return h.app.inject({
    method: 'GET', url: `/api/v1/p/p1${path}`,
    headers: { authorization: `Bearer ${token}`, ...extraHeaders },
  })
}

/**
 * Counts everything queued for derivation, across every person. There is only ever one person in
 * this file's harness and nothing else in these tests marks a day dirty, so a plain count is
 * enough to answer whether a note or an event write touched the queue at all.
 */
function pendingDeriveCount(h: Harness): number {
  return h.app.haelan.instance.deriveQueue.size()
}

describe('the note and event routes', () => {
  it('upserts the day\'s note rather than adding a second', async () => {
    harness = await withServer(); const token = await harness.signIn()
    await putNote(harness, token, '2026-08-15', 'first')
    await putNote(harness, token, '2026-08-15', 'second')

    // No GET /notes yet (that is Task 6's route); read the store the route itself writes through.
    const list = harness.app.haelan.instance.notes.listFor('p1', '2026-08-01', '2026-08-31')
    expect(list).toHaveLength(1)
    expect(list[0]!.body).toBe('second')
  })

  it('answers 400 for a local date the calendar does not have', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const write = await harness.app.inject({
      method: 'PUT', url: '/api/v1/p/p1/notes/2026-02-30',
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      payload: { body: 'x' },
    })
    expect(write.statusCode).toBe(400)
    expect(write.json().error.kind).toBe('config')
  })

  it('accepts an event kind outside the seed set', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const write = await postEvent(harness, token, { kind: 'dentist', startedAtMs: 1_770_000_000_000 })
    expect(write.statusCode).toBe(200)

    // No GET /events yet either; bracket the fixture's own timestamp rather than the '2026-08'
    // range the eventual route will take, since this event was not planted in August.
    const list = harness.app.haelan.instance.events.listFor('p1', 1_769_000_000_000, 1_771_000_000_000)
    expect(list[0]!.kind).toBe('dentist')
  })

  it('removes an event by id', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const id = (await postEvent(harness, token, { kind: 'travel', startedAtMs: 1_770_000_000_000 })).json().id
    const removed = await harness.app.inject({
      method: 'DELETE', url: `/api/v1/p/p1/events/${id}`,
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    })
    expect(removed.statusCode).toBe(200)
    expect(harness.app.haelan.instance.events.listFor('p1', 1_769_000_000_000, 1_771_000_000_000)).toHaveLength(0)
  })

  it('removes a note by local date', async () => {
    harness = await withServer(); const token = await harness.signIn()
    await putNote(harness, token, '2026-08-15', 'flew to Tokyo')
    const removed = await harness.app.inject({
      method: 'DELETE', url: '/api/v1/p/p1/notes/2026-08-15',
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json()).toMatchObject({ id: '2026-08-15' })
    expect(harness.app.haelan.instance.notes.listFor('p1', '2026-08-01', '2026-08-31')).toHaveLength(0)
  })

  it('answers 200 removing a date that was never noted, and leaves other days alone', async () => {
    harness = await withServer(); const token = await harness.signIn()
    await putNote(harness, token, '2026-08-16', 'stays')
    const removed = await harness.app.inject({
      method: 'DELETE', url: '/api/v1/p/p1/notes/2026-08-15',
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    })
    expect(removed.statusCode).toBe(200)
    expect(harness.app.haelan.instance.notes.listFor('p1', '2026-08-01', '2026-08-31')).toHaveLength(1)
  })

  // A note write must not enqueue a re-derive: it changes no number, and marking days dirty would
  // make every note cost a derivation.
  it('marks nothing dirty when a note is written', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const before = pendingDeriveCount(harness)
    await putNote(harness, token, '2026-08-15', 'flew to Tokyo')
    expect(pendingDeriveCount(harness)).toBe(before)
  })

  it('marks nothing dirty when a note is removed', async () => {
    harness = await withServer(); const token = await harness.signIn()
    await putNote(harness, token, '2026-08-15', 'flew to Tokyo')
    const before = pendingDeriveCount(harness)
    await harness.app.inject({
      method: 'DELETE', url: '/api/v1/p/p1/notes/2026-08-15',
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    })
    expect(pendingDeriveCount(harness)).toBe(before)
  })
})

describe('GET /notes', () => {
  it('answers a 304 for an unchanged list', async () => {
    harness = await withServer(); const token = await harness.signIn()
    await putNote(harness, token, '2026-08-15', 'flew to Tokyo')
    const first = await get(harness, token, '/notes?from=2026-08-01&to=2026-08-31')
    const again = await get(harness, token, '/notes?from=2026-08-01&to=2026-08-31',
      { 'if-none-match': first.headers.etag as string })
    expect(again.statusCode).toBe(304)
  })

  it('moves the etag when the list changes', async () => {
    harness = await withServer(); const token = await harness.signIn()
    await putNote(harness, token, '2026-08-15', 'first')
    const before = (await get(harness, token, '/notes?from=2026-08-01&to=2026-08-31')).headers.etag
    await putNote(harness, token, '2026-08-16', 'second')
    const after = (await get(harness, token, '/notes?from=2026-08-01&to=2026-08-31')).headers.etag
    expect(after).not.toBe(before)
  })

  it('returns every row in range without a cursor', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 31; day += 1) {
      await putNote(harness, token, `2026-08-${String(day).padStart(2, '0')}`, `day ${day}`)
    }
    const list = await get(harness, token, '/notes?from=2026-08-01&to=2026-08-31')
    expect(list.json().items).toHaveLength(31)
    expect(list.json().cursor).toBeUndefined()
  })

  it('excludes a note outside the requested range', async () => {
    harness = await withServer(); const token = await harness.signIn()
    await putNote(harness, token, '2026-07-31', 'the day before')
    await putNote(harness, token, '2026-08-01', 'in range')
    const list = await get(harness, token, '/notes?from=2026-08-01&to=2026-08-31')
    expect(list.json().items).toHaveLength(1)
    expect(list.json().items[0].body).toBe('in range')
  })

  it('refuses a malformed from date', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/notes?from=2026-02-30&to=2026-08-31')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  it('refuses a range where from is after to', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/notes?from=2026-08-31&to=2026-08-01')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })
})

describe('GET /events', () => {
  it('answers a 304 for an unchanged list', async () => {
    harness = await withServer(); const token = await harness.signIn()
    await postEvent(harness, token, { kind: 'travel', startedAtMs: Date.parse('2026-08-15T09:00:00Z') })
    const first = await get(harness, token, '/events?from=2026-08-01&to=2026-08-31')
    const again = await get(harness, token, '/events?from=2026-08-01&to=2026-08-31',
      { 'if-none-match': first.headers.etag as string })
    expect(again.statusCode).toBe(304)
  })

  it('moves the etag when the list changes', async () => {
    harness = await withServer(); const token = await harness.signIn()
    await postEvent(harness, token, { kind: 'travel', startedAtMs: Date.parse('2026-08-15T09:00:00Z') })
    const before = (await get(harness, token, '/events?from=2026-08-01&to=2026-08-31')).headers.etag
    await postEvent(harness, token, { kind: 'illness', startedAtMs: Date.parse('2026-08-16T09:00:00Z') })
    const after = (await get(harness, token, '/events?from=2026-08-01&to=2026-08-31')).headers.etag
    expect(after).not.toBe(before)
  })

  it('returns every event in range without a cursor', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 10; day += 1) {
      await postEvent(harness, token, { kind: 'travel', startedAtMs: Date.parse(`2026-08-${String(day).padStart(2, '0')}T09:00:00Z`) })
    }
    const list = await get(harness, token, '/events?from=2026-08-01&to=2026-08-10')
    expect(list.json().items).toHaveLength(10)
    expect(list.json().cursor).toBeUndefined()
  })

  // The point of this task: localDate is computed once, to decide whether a row belongs in the
  // range at all (the filter just above this route's own handler), and handed back on the item
  // rather than thrown away, so a browser placing this event on a chart never has to recompute the
  // same DST sensitive arithmetic itself. Offset 120 (UTC+2) is what makes this a real assertion
  // rather than a coincidence: at offset zero the local day and the UTC day are the same string
  // regardless of whether the route actually resolved one.
  it("answers each event's own localDate, resolved from its offset rather than its UTC instant", async () => {
    harness = await withServer(); const token = await harness.signIn()
    await postEvent(harness, token, {
      kind: 'travel',
      startedAtMs: Date.parse('2026-08-10T22:30:00Z'), // 2026-08-11T00:30 local at UTC+2
      startedAtOffsetMinutes: 120,
    })
    const list = await get(harness, token, '/events?from=2026-08-11&to=2026-08-11')
    const items = list.json().items as { kind: string, localDate: string }[]
    expect(items).toHaveLength(1)
    expect(items[0]!.localDate).toBe('2026-08-11')
  })

  // At offset zero the local day and the UTC day are the same day, so this only proves the
  // boundary is millisecond exact, not that it is the local day the route claims to answer by.
  // The nonzero offset case below is what actually exercises that.
  it('includes the whole UTC day at each end of the range, and nothing past it, at offset zero', async () => {
    harness = await withServer(); const token = await harness.signIn()
    await postEvent(harness, token, { kind: 'before', startedAtMs: Date.parse('2026-07-31T23:59:59.999Z') })
    await postEvent(harness, token, { kind: 'at-start', startedAtMs: Date.parse('2026-08-01T00:00:00.000Z') })
    await postEvent(harness, token, { kind: 'at-end', startedAtMs: Date.parse('2026-08-01T23:59:59.999Z') })
    await postEvent(harness, token, { kind: 'after', startedAtMs: Date.parse('2026-08-02T00:00:00.000Z') })

    const list = await get(harness, token, '/events?from=2026-08-01&to=2026-08-01')
    const kinds = (list.json().items as { kind: string }[]).map((e) => e.kind).sort()
    expect(kinds).toEqual(['at-end', 'at-start'])
  })

  // The case a UTC calendar day gets wrong. At UTC+2, 00:30 local on `from` is 22:30Z the day
  // before: a UTC window starting at `from`T00:00:00Z misses it even though its own local day is
  // in range. And at UTC+2, 00:30 local the day after `to` is 22:30Z on `to` itself: a UTC window
  // ending at `to`T23:59:59.999Z catches it even though its own local day is out of range. Both
  // have to be judged by localDateOf(startedAtMs, startedAtOffsetMinutes), the row's own answer
  // to which day it is on, not by where the row's UTC instant happens to fall.
  it("honors each event's own offset at the range boundaries, not the UTC calendar day", async () => {
    harness = await withServer(); const token = await harness.signIn()
    const offset = 120 // UTC+2, Europe/Amsterdam in August, the harness default person's own zone.
    await postEvent(harness, token, {
      kind: 'just-after-midnight-on-from',
      startedAtMs: Date.parse('2026-07-31T22:30:00Z'), // 2026-08-01T00:30 local
      startedAtOffsetMinutes: offset,
    })
    await postEvent(harness, token, {
      kind: 'late-evening-on-to',
      startedAtMs: Date.parse('2026-08-10T21:30:00Z'), // 2026-08-10T23:30 local
      startedAtOffsetMinutes: offset,
    })
    await postEvent(harness, token, {
      kind: 'just-after-midnight-past-to',
      startedAtMs: Date.parse('2026-08-10T22:30:00Z'), // 2026-08-11T00:30 local, one day past `to`
      startedAtOffsetMinutes: offset,
    })

    const list = await get(harness, token, '/events?from=2026-08-01&to=2026-08-10')
    const kinds = (list.json().items as { kind: string }[]).map((e) => e.kind).sort()
    expect(kinds).toEqual(['just-after-midnight-on-from', 'late-evening-on-to'])
  })

  it('refuses a range where from is after to', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/events?from=2026-08-31&to=2026-08-01')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })
})

describe('GET /overrides', () => {
  it('answers a 304 for an unchanged list', async () => {
    harness = await withServer(); const token = await harness.signIn()
    putOverride(harness, '2026-08-15', 'steps')
    const first = await get(harness, token, '/overrides')
    const again = await get(harness, token, '/overrides', { 'if-none-match': first.headers.etag as string })
    expect(again.statusCode).toBe(304)
  })

  it('moves the etag when the list changes', async () => {
    harness = await withServer(); const token = await harness.signIn()
    putOverride(harness, '2026-08-15', 'steps')
    const before = (await get(harness, token, '/overrides')).headers.etag
    putOverride(harness, '2026-08-16', 'floors')
    const after = (await get(harness, token, '/overrides')).headers.etag
    expect(after).not.toBe(before)
  })

  // No from/to: the management list this feeds wants every correction for the person, and
  // OverrideStore.listFor answers exactly that, with nothing to range against in the response.
  it('returns every override for the person, unpaginated', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 5; day += 1) {
      putOverride(harness, `2026-08-${String(day).padStart(2, '0')}`, 'steps')
    }
    const list = await get(harness, token, '/overrides')
    expect(list.json().items).toHaveLength(5)
    expect(list.json().cursor).toBeUndefined()
  })
})
