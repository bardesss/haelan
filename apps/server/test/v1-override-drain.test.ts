import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  DERIVATION_VERSION, MAPPING_VERSION, dayMetricTarget, runDerive, sampleTarget, schema,
} from '@haelan/core'
import { DRAIN_BATCH_DAYS } from '../src/routes/v1/annotations.ts'
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

/** Counts how many batches the route actually took, through the real object it drains with. */
function countClaims(h: Harness): { count: number } {
  const queue = h.app.haelan.instance.deriveQueue
  const real = queue.claim.bind(queue)
  const counter = { count: 0 }
  queue.claim = (limit, personIds) => {
    counter.count += 1
    return real(limit, personIds)
  }
  return counter
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

  // The gate SyncRunner#eligible puts in front of its own loop. A person whose boot rebuild
  // failed carries tier 2 built by an older mapper; deriving their days now would write tier 3 at
  // the current version over it, which is the mixing the version stamp exists to prevent. The
  // runner already refuses to schedule that, and an authenticated write must not be another way
  // in. Ownership is not build state, so requirePerson does not cover this.
  it('leaves a person whose rebuild is outstanding undrained, and says applied false', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSamplesFor(harness, '2026-08-15', 'steps', 900)
    drainOnce(harness)
    harness.app.haelan.stores.people.stampBuiltVersions({
      id: 'p1', mappingVersion: MAPPING_VERSION, derivationVersion: DERIVATION_VERSION - 1,
    })
    const claims = countClaims(harness)

    const write = await postOverride(harness, token, 'steps', '2026-08-15')
    expect(write.statusCode).toBe(200)
    // Zero batches, not merely an unapplied answer: a drain that crashed would also report
    // applied false, and "did not derive" is the whole subject of the quarantine.
    expect(claims.count).toBe(0)
    expect(write.json().applied).toBe(false)
    expect(harness.app.haelan.instance.deriveQueue.has({ personId: 'p1', localDate: '2026-08-15' })).toBe(true)
    // The override is stored and the day is untouched, which is what applied false claimed.
    expect(harness.app.haelan.instance.overrides.listFor('p1')).toHaveLength(1)
    const after = await get(harness, token, STEPS_ON_THE_15TH)
    expect(after.json().steps.points[0].value).toBe(900)
  })

  // better-sqlite3 is synchronous, so a drain that runs long in a request holds the event loop
  // for every other route, every other person and the runner's timers. The batch bound alone
  // cannot promise anything, since how long a batch takes is a property of the data.
  it('gives up the event loop when the drain outruns its time budget', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSamplesFor(harness, '2026-08-15', 'steps', 900)
    drainOnce(harness)
    makeTheDrainNeverFinish(harness)
    const claims = countClaims(harness)

    // Every reading five seconds later than the last, so the budget is spent after the first
    // batch and the batch bound is not what stops the loop. Restored in a finally: a rejected
    // inject would otherwise leak a mocked clock into every test after this one.
    let ticks = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      ticks += 5_000
      return ticks
    })
    let write
    try {
      write = await postOverride(harness, token, 'steps', '2026-08-15')
    } finally {
      clock.mockRestore()
    }

    expect(claims.count).toBe(1)
    expect(write.statusCode).toBe(200)
    expect(write.json().applied).toBe(false)
  })

  // The budget is checked between batches, so a batch is the granularity at which the drain can
  // be preempted and its size is how far past the budget a handler can run. At runDerive's
  // default of 64 a single batch of dense days could block for seconds with the budget unable to
  // interrupt it, which is a bound that reads as a guarantee and is not one.
  it('takes the drain in small batches, so the budget can interrupt it', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedSamplesFor(harness, '2026-08-15', 'steps', 900)
    drainOnce(harness)
    const backlog = 70
    seedBacklog(harness, backlog)
    const claims = countClaims(harness)

    // Frozen rather than real, so the budget cannot fire. This test is about how many batches the
    // drain takes, and with a real clock it also asserted that 71 derivations finish inside
    // DRAIN_BUDGET_MS on a machine sharing its cores with the rest of the suite. That is a race,
    // not a guarantee: it passed when this file ran alone and failed under the full suite, and
    // what tipped it was a wrapper element added to a chart component, which cannot touch the
    // drain and only ever changed how much work ran beside it. Restored in a finally for the same
    // reason the test above gives.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    let write
    try {
      write = await postOverride(harness, token, 'steps', '2026-08-15')
    } finally {
      clock.mockRestore()
    }

    expect(write.json().applied).toBe(true)
    // The backlog plus the day this write marked, in batches of DRAIN_BATCH_DAYS, plus the empty
    // claim that ends the loop. At the default batch size this would be three.
    expect(claims.count).toBe(Math.ceil((backlog + 1) / DRAIN_BATCH_DAYS) + 1)
  })

  // Resolving the day is a database read for a sample or a session, so it has to happen before
  // the write rather than after it: a throw once the override is committed would be a 500 over a
  // saved correction, which is the one outcome the 200 with applied false exists to avoid. The
  // empty store is the assertion; the status only says something went wrong.
  it('stores nothing when the affected day cannot be resolved', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const overrides = harness.app.haelan.instance.overrides
    overrides.affectedLocalDate = () => { throw new Error('the day cannot be resolved') }

    const write = await postOverride(harness, token, 'steps', '2026-08-15')
    expect(write.statusCode).toBe(500)
    expect(overrides.listFor('p1')).toEqual([])
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

  // A correction at day scope is refused for naming no source, before the missing value is ever
  // looked at, so this pins that rule and the one below pins the other. Two cases rather than one
  // named after a branch it never reaches.
  it('answers 400 for a correction at day scope, through the shared error envelope', async () => {
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
    expect(write.json().error.message).toContain('can only exclude')
  })

  it('answers 400 for a correcting override that carries no value', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const write = await harness.app.inject({
      method: 'POST', url: '/api/v1/p/p1/overrides',
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      payload: {
        // Sample scope, the one scope a correction is allowed at, so the refusal is about the
        // missing number rather than about where it was aimed.
        scope: 'sample',
        targetKey: sampleTarget({ source: 'watch', metric: 'steps', utcMs: Date.parse('2026-08-15T07:00:00Z') }),
        action: 'correct', reason: 'meter read high',
      },
    })
    expect(write.statusCode).toBe(400)
    expect(write.json().error.message).toContain('corrected value')
    expect(harness.app.haelan.instance.overrides.listFor('p1')).toEqual([])
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
