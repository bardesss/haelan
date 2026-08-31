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

async function postEvent(h: Harness, token: string, input: { kind: string, startedAtMs: number }) {
  return h.app.inject({
    method: 'POST', url: '/api/v1/p/p1/events',
    headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    payload: input,
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

  // A note write must not enqueue a re-derive: it changes no number, and marking days dirty would
  // make every note cost a derivation.
  it('marks nothing dirty when a note is written', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const before = pendingDeriveCount(harness)
    await putNote(harness, token, '2026-08-15', 'flew to Tokyo')
    expect(pendingDeriveCount(harness)).toBe(before)
  })
})
