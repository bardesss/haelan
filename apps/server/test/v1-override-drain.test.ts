import { describe, it, expect, afterEach } from 'vitest'
import { dayMetricTarget, runDerive, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// A mutating request is refused by the origin hook (routes/auth.ts) unless the two agree, so
// every write below carries both. A test that forgot one would fail on a 403 that says nothing
// about what it was written to check.
const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }

// Fixed rather than the person's timezone: the local day a sample belongs to is read off the
// row's own offset, so the seed has to name one.
const OFFSET_MINUTES = 120

/**
 * One synthetic reading on a local day, plus the queue mark sync would have left behind. Nothing
 * here comes from a real record: one invented number, one invented device.
 */
function seedSamplesFor(h: Harness, localDate: string, metric: string, value: number): void {
  const instance = h.app.haelan.instance
  instance.db.insert(schema.sources).values({
    id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'watch', kind: 'device', createdAtMs: 0,
  }).onConflictDoNothing().run()
  instance.db.insert(schema.samples).values({
    personId: 'p1', sourceId: 'watch', metric,
    utcMs: Date.parse(`${localDate}T09:00:00Z`) - OFFSET_MINUTES * 60_000,
    tzOffsetMinutes: OFFSET_MINUTES, agg: 'raw', value, n: 1, rawPayloadId: null,
  }).run()
  instance.deriveQueue.markDirty({ personId: 'p1', localDate, nowMs: h.clock.nowMs })
}

/** The baseline a reader would already be looking at when they open the panel. */
function drainOnce(h: Harness): void {
  const instance = h.app.haelan.instance
  runDerive({
    db: instance.db, queue: instance.deriveQueue, priority: instance.sourcePriority,
    overrides: instance.overrides, settings: instance.settings, nowMs: h.clock.nowMs,
    personIds: ['p1'],
  })
}

/**
 * A backlog of dirty days older than anything the request will mark. claim takes the oldest
 * first, so these sort ahead of the override's own day and a single runDerive call never reaches
 * it: this is what the route's bounded loop exists for.
 */
function seedBacklog(h: Harness, days: number): void {
  const queue = h.app.haelan.instance.deriveQueue
  for (let i = 0; i < days; i++) {
    // 2025, a year no test in this file has data in, so a derived day here is an empty one.
    const localDate = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)
    queue.markDirty({ personId: 'p1', localDate, nowMs: h.clock.nowMs - 1_000_000 - i })
  }
}

/** The real object the route drains through, made to fail where it reads the queue. */
function breakTheDrain(h: Harness): void {
  h.app.haelan.instance.deriveQueue.claim = () => {
    throw new Error('the derive queue is unreadable')
  }
}

/**
 * A queue that hands days out and never retires them. The drain runs to its bound without ever
 * throwing, which is the case the route cannot answer by watching for an exception.
 */
function makeTheDrainNeverFinish(h: Harness): void {
  h.app.haelan.instance.deriveQueue.clear = () => {}
}

async function get(h: Harness, token: string, path: string) {
  return h.app.inject({
    method: 'GET', url: `/api/v1/p/p1${path}`, headers: { authorization: `Bearer ${token}` },
  })
}

async function postOverride(h: Harness, token: string, metric: string, localDate: string) {
  return h.app.inject({
    method: 'POST', url: '/api/v1/p/p1/overrides',
    headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    payload: {
      scope: 'day_metric', targetKey: dayMetricTarget({ localDate, metric }),
      action: 'exclude', reason: 'phone in a bag',
    },
  })
}

const STEPS_ON_THE_15TH = '/series?metric=steps&agg=sum&from=2026-08-15&to=2026-08-15'

describe('POST /overrides', () => {
  // The whole point of draining in the request: the number a reader sees after the panel closes
  // is the corrected one, not the one that was wrong when they clicked.
  it('applies the correction before it responds', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSamplesFor(harness, '2026-08-15', 'steps', 900)
    drainOnce(harness)

    const before = await get(harness, token, STEPS_ON_THE_15TH)
    expect(before.json().steps.points[0].value).toBe(900)

    const write = await postOverride(harness, token, 'steps', '2026-08-15')
    expect(write.statusCode).toBe(200)
    expect(write.json().applied).toBe(true)
    expect(write.json().affected).toMatchObject({ from: '2026-08-15', to: '2026-08-15' })

    const after = await get(harness, token, STEPS_ON_THE_15TH)
    expect(after.json().steps.points).toHaveLength(0)
  })

  // The defect a single runDerive call carries. claim takes the oldest 64 days first and this
  // write marks its day now, so behind a backfill's backlog one call drains days that are not
  // this one, returns without throwing, and a route that read success off the absence of a throw
  // would call a stale number an applied correction.
  it('applies a correction that sits behind a backlog of dirty days', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSamplesFor(harness, '2026-08-15', 'steps', 900)
    drainOnce(harness)
    seedBacklog(harness, 70)

    const write = await postOverride(harness, token, 'steps', '2026-08-15')
    expect(write.statusCode).toBe(200)
    expect(write.json().applied).toBe(true)

    const after = await get(harness, token, STEPS_ON_THE_15TH)
    expect(after.json().steps.points).toHaveLength(0)
  })

  it('restores the original when the override is removed', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSamplesFor(harness, '2026-08-15', 'steps', 900)
    drainOnce(harness)
    const id = (await postOverride(harness, token, 'steps', '2026-08-15')).json().id

    const removed = await harness.app.inject({
      method: 'DELETE', url: `/api/v1/p/p1/overrides/${id}`,
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().applied).toBe(true)
    expect(removed.json().affected).toMatchObject({ from: '2026-08-15', to: '2026-08-15' })

    const after = await get(harness, token, STEPS_ON_THE_15TH)
    expect(after.json().steps.points[0].value).toBe(900)
  })

  // The failure mode draining inside a request introduces. The override is committed either way,
  // so a 500 would invite the reader to write it twice; what must not happen is reporting a stale
  // number as an applied one.
  it('answers saved but not applied when the drain fails', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSamplesFor(harness, '2026-08-15', 'steps', 900)
    drainOnce(harness)
    breakTheDrain(harness)

    const write = await postOverride(harness, token, 'steps', '2026-08-15')
    expect(write.statusCode).toBe(200)
    expect(write.json().applied).toBe(false)
    expect(harness.app.haelan.instance.overrides.listFor('p1')).toHaveLength(1)

    // Still the old number, and the response said so. That agreement is the whole contract.
    const after = await get(harness, token, STEPS_ON_THE_15TH)
    expect(after.json().steps.points[0].value).toBe(900)
  })

  // The harder half, and the one no try/catch can answer: the drain runs to its bound without
  // throwing and the day is still queued. Only asking the queue tells these apart from success.
  it('answers saved but not applied when a clean drain leaves the day queued', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSamplesFor(harness, '2026-08-15', 'steps', 900)
    drainOnce(harness)
    makeTheDrainNeverFinish(harness)

    const write = await postOverride(harness, token, 'steps', '2026-08-15')
    expect(write.statusCode).toBe(200)
    expect(write.json().applied).toBe(false)
    expect(harness.app.haelan.instance.overrides.listFor('p1')).toHaveLength(1)
  })

  // Section 15, at the one moment a request does work on somebody's behalf. An unscoped drain
  // would derive whatever another person had queued, inside a request that never named them.
  it('derives only the writer own days, and leaves another person queued', async () => {
    harness = await withServer(); const token = await harness.signIn()
    await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
    const queue = harness.app.haelan.instance.deriveQueue
    queue.markDirty({ personId: 'p2', localDate: '2026-08-15', nowMs: harness.clock.nowMs - 1_000_000 })
    seedSamplesFor(harness, '2026-08-15', 'steps', 900)
    drainOnce(harness)

    const write = await postOverride(harness, token, 'steps', '2026-08-15')
    expect(write.json().applied).toBe(true)
    expect(queue.has({ personId: 'p2', localDate: '2026-08-15' })).toBe(true)
  })

  it('refuses a write whose origin does not match the host', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const write = await harness.app.inject({
      method: 'POST', url: '/api/v1/p/p1/overrides',
      headers: { authorization: `Bearer ${token}`, origin: 'http://evil.example', host: 'localhost:4235' },
      payload: { scope: 'day_metric', targetKey: '{}', action: 'exclude', reason: 'x' },
    })
    expect(write.statusCode).toBe(403)
    expect(harness.app.haelan.instance.overrides.listFor('p1')).toEqual([])
  })

  it('answers 400 for a correct action with no value, through the shared error envelope', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const write = await harness.app.inject({
      method: 'POST', url: '/api/v1/p/p1/overrides',
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      payload: {
        scope: 'day_metric', targetKey: dayMetricTarget({ localDate: '2026-08-15', metric: 'steps' }),
        action: 'correct', reason: 'meter read high',
      },
    })
    expect(write.statusCode).toBe(400)
    expect(write.json().error.kind).toBe('config')
  })

  // JSON carries types a query string cannot, and a scope the store has no branch for would be
  // stored and then match nothing at derivation, which looks like a day with no override at all.
  it('answers 400 for a scope it does not know', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const write = await harness.app.inject({
      method: 'POST', url: '/api/v1/p/p1/overrides',
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      payload: { scope: 'week_metric', targetKey: '{}', action: 'exclude', reason: 'x' },
    })
    expect(write.statusCode).toBe(400)
    expect(write.json().error.kind).toBe('config')
    expect(harness.app.haelan.instance.overrides.listFor('p1')).toEqual([])
  })
})

describe('DELETE /overrides/:overrideId', () => {
  // Not a 200 over a store call that quietly did nothing: a removal that answers success without
  // removing anything is the one answer a reader cannot check.
  it('answers 404 for an override that is not this person own', async () => {
    harness = await withServer(); const token = await harness.signIn()
    await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
    const theirs = harness.app.haelan.instance.overrides.put({
      personId: 'p2', scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-08-15', metric: 'steps' }),
      action: 'exclude', reason: 'theirs', nowMs: harness.clock.nowMs,
    })

    const removed = await harness.app.inject({
      method: 'DELETE', url: `/api/v1/p/p1/overrides/${theirs}`,
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    })
    expect(removed.statusCode).toBe(404)
    expect(removed.json().error.kind).toBe('not_found')
    expect(harness.app.haelan.instance.overrides.listFor('p2')).toHaveLength(1)
  })
})
