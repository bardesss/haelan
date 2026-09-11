import { describe, it, expect, afterEach } from 'vitest'
import { DATA_TYPES, supports } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const headers = { origin: 'http://localhost:4235', host: 'localhost:4235' }

// Every type status() reports on. It filters on supporting `list`, since a type with no listing
// action has no backfill to hold a cursor for, and the counts below are what prove a second
// person's rows are absent rather than merely unread: before scoping, the array held one entry
// per person per type, so its length alone was double this.
const LISTABLE = DATA_TYPES.filter((type) => supports(type, 'list')).map((type) => type.id)

// Far enough back to be unmistakable, and nothing like the horizon floors the runner computes,
// so a leaked value cannot be mistaken for one the reader's own state would have produced.
const OWNER_CURSOR_MS = 1_600_000_000_000

async function sessionCookie(h: Harness, username: string): Promise<string> {
  const response = await h.app.inject({
    method: 'POST', url: '/api/auth/login', headers,
    payload: { username, password: 'a good long password' },
  })
  expect(response.statusCode).toBe(200)
  return response.cookies.find((c) => c.name === 'haelan_session')!.value
}

/**
 * The household these tests run against: p1 is the connected person the wizard produced, with a
 * refresh token and a distinctive backfill cursor on every type, and p2 is a second member with
 * an account and nothing else. Anything p2 can see of p1 is the leak.
 */
async function twoPeople(h: Harness): Promise<void> {
  await h.connectPerson()
  await h.addPerson({ id: 'p2', displayName: 'Second', username: 'second' })
  for (const dataType of LISTABLE) {
    h.app.haelan.stores.syncState.setBackfillCursor({
      personId: 'p1', dataType, cursorMs: OWNER_CURSOR_MS, nowMs: h.clock.nowMs,
    })
    h.app.haelan.stores.syncState.markBackfillComplete({
      personId: 'p1', dataType, nowMs: h.clock.nowMs,
    })
  }
}

interface Backfill { dataType: string, complete: boolean, cursorMs: number | null }
interface Status { personId: string, backfill: Backfill[] }

/** Everything p2 must never be told about p1, in one place so all three tests below agree. */
function expectOwnRowsOnly(status: Status): void {
  // The leak first, the label after. Asserting personId up here would trip on the missing field
  // before reaching these, and hide which of the two problems a regression actually reintroduced.

  // p2 has synced nothing, so every row of a correctly scoped answer is empty. A leaked row
  // carries p1's cursor and its completion mark, and both are visible right here.
  expect(status.backfill.every((row) => row.cursorMs === null)).toBe(true)
  expect(status.backfill.every((row) => row.complete === false)).toBe(true)
  // One row per listable type, not one per person per type.
  expect(status.backfill.map((row) => row.dataType).sort()).toEqual([...LISTABLE].sort())
  expect(status.personId).toBe('p2')
}

/**
 * A real listener, not app.inject. The events handler calls reply.hijack() and holds the
 * connection open until the client goes away, so inject's payload promise never settles and a
 * test written against it would hang rather than fail.
 */
async function streamUrl(h: Harness): Promise<string> {
  const address = await h.app.listen({ port: 0, host: '127.0.0.1' })
  return `${address}/api/sync/events`
}

/**
 * Reads server-sent frames off a live stream into an array that keeps filling until stop() is
 * called. An array rather than a promise per frame is what lets a test start a run, wait for it
 * to finish, and only then look at everything the stream said meanwhile.
 */
function collectFrames(url: string, cookie: string): {
  frames: unknown[]
  ready: Promise<void>
  stop: () => void
} {
  const controller = new AbortController()
  const frames: unknown[] = []
  let markReady = (): void => {}
  const ready = new Promise<void>((resolve) => { markReady = resolve })

  const pump = async () => {
    const response = await fetch(url, {
      headers: { cookie: `haelan_session=${cookie}` }, signal: controller.signal,
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      // Frames are separated by a blank line. Keepalives are comment lines carrying no `data: `
      // and fall out here, which is right: they are not something the server said about anybody.
      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        if (frame.startsWith('data: ')) {
          frames.push(JSON.parse(frame.slice('data: '.length)))
          markReady()
        }
        split = buffer.indexOf('\n\n')
      }
    }
  }
  // An aborted read is how stop() ends this, not a failure. Resolving ready on the way out
  // keeps a test that never receives a first frame failing on its assertion rather than hanging.
  void pump().catch(() => { markReady() })

  return { frames, ready, stop: () => controller.abort() }
}

describe('sync isolation', () => {
  it('never reports another person backfill state on the status route', async () => {
    harness = await withServer({ google: 'ok' })
    await twoPeople(harness)
    const cookie = await sessionCookie(harness, 'second')

    const response = await harness.app.inject({
      method: 'GET', url: '/api/sync/status', cookies: { haelan_session: cookie },
    })

    expect(response.statusCode).toBe(200)
    expectOwnRowsOnly(response.json() as Status)
  })

  it('names whose snapshot it is, so a switched person cannot render a stale one as its own', async () => {
    harness = await withServer({ google: 'ok' })
    await twoPeople(harness)
    const owner = await sessionCookie(harness, 'robin')

    const response = await harness.app.inject({
      method: 'GET', url: '/api/sync/status', cookies: { haelan_session: owner },
    })

    const status = response.json() as Status
    expect(status.personId).toBe('p1')
    // The same request as the test above, from the person who does own this state. Without this,
    // a status route that reported nothing to anybody would pass the isolation assertions.
    expect(status.backfill.every((row) => row.cursorMs === OWNER_CURSOR_MS)).toBe(true)
    expect(status.backfill.every((row) => row.complete)).toBe(true)
  })

  it('scopes the snapshot the event stream opens with, not only the status route', async () => {
    harness = await withServer({ google: 'ok' })
    await twoPeople(harness)
    const cookie = await sessionCookie(harness, 'second')

    const stream = collectFrames(await streamUrl(harness), cookie)
    await stream.ready
    stream.stop()

    expect(stream.frames).toHaveLength(1)
    expectOwnRowsOnly(stream.frames[0] as Status)
  })

  it('forwards no progress event about another person to a listening member', async () => {
    harness = await withServer({ google: 'ok' })
    await twoPeople(harness)
    const cookie = await sessionCookie(harness, 'second')

    const stream = collectFrames(await streamUrl(harness), cookie)
    await stream.ready

    // p1 is the only person holding a refresh token, so every job this run emits is p1's. p2 is
    // listening throughout and must be told nothing about any of it.
    harness.app.haelan.runner.tryStart('manual')
    await harness.app.haelan.runner.settle()
    await new Promise((resolve) => setImmediate(resolve))
    stream.stop()

    const leaked = stream.frames.filter((frame) => {
      const personId = (frame as { personId?: unknown }).personId
      return personId !== undefined && personId !== 'p2'
    })
    expect(leaked).toEqual([])
  })
})
