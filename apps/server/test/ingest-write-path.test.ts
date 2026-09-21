import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { samplePoint, schema } from '@haelan/core'
import type { DbOrTx } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// A mutating request is refused by the origin hook unless these two agree. See v1-ingest.test.ts.
const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }

async function ingest(token: string, path: string, payload: Record<string, unknown>) {
  if (!harness) throw new Error('no harness')
  return harness.app.inject({
    method: 'POST', url: path,
    headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    payload,
  })
}

describe('the samples insert statement', () => {
  // A test that only counts rows written passes whether writeSamples prepares one statement or
  // one per row - both shapes write the same rows. What actually differs, and what made a rebuild
  // run out of memory (packages/core/src/rebuild/replay.ts's comment, #275), is how many times a
  // fresh statement gets prepared. better-sqlite3 does not publish a count of statements a
  // connection is holding, so there is nothing to read that back off after the fact; the only
  // reachable seam is the call into drizzle that prepares one, which is what this spies on.
  //
  // Wrapping instance.db.transaction rather than exporting writeSamples for the test to call
  // directly: this exercises the real request path, through the real tx the route hands it,
  // rather than a hand built one that could drift from what registerIngestRoutes actually passes.
  it('calls tx.insert(schema.samples) once for a multi row upload, not once per row', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const instance = harness.app.haelan.instance

    const base = Date.UTC(2026, 0, 1)
    const dataPoints = Array.from({ length: 5 }, (_, index) => samplePoint({
      payloadKey: 'weight',
      valuePath: 'weightGrams',
      value: '80000',
      physicalTime: new Date(base + index * 60_000).toISOString(),
    }))

    const sampleInsertCalls: unknown[] = []
    const realTransaction = instance.db.transaction.bind(instance.db)
    const transactionSpy = vi.spyOn(instance.db, 'transaction')
      .mockImplementation(((callback: (tx: DbOrTx) => unknown) =>
        realTransaction((tx) => {
          const insertSpy = vi.spyOn(tx, 'insert')
          try {
            return callback(tx)
          } finally {
            sampleInsertCalls.push(...insertSpy.mock.calls.filter(([table]) => table === schema.samples))
            insertSpy.mockRestore()
          }
        })) as typeof instance.db.transaction)

    let response
    try {
      response = await ingest(token, '/api/v1/p/p1/ingest/weight', { dataPoints })
    } finally {
      transactionSpy.mockRestore()
    }

    expect(response.statusCode).toBe(200)
    // The control: five rows really were written, so a call count of one below is hoisting and
    // not five points quietly failing to map.
    expect((response.json() as { rowsWritten: number }).rowsWritten).toBe(5)
    expect(sampleInsertCalls).toHaveLength(1)
  })

  // The other end of the same claim: a single row upload calls insert() once either way, so the
  // test above only tells the two shapes apart at more than one row. Pinned so a future edit
  // cannot shrink the multi row test back down to something that stops discriminating.
  it('writes a single row through the same one insert() call', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const instance = harness.app.haelan.instance

    const dataPoints = [samplePoint({
      payloadKey: 'weight', valuePath: 'weightGrams', value: '80000',
      physicalTime: '2026-08-18T10:00:00Z',
    })]

    const sampleInsertCalls: unknown[] = []
    const realTransaction = instance.db.transaction.bind(instance.db)
    const transactionSpy = vi.spyOn(instance.db, 'transaction')
      .mockImplementation(((callback: (tx: DbOrTx) => unknown) =>
        realTransaction((tx) => {
          const insertSpy = vi.spyOn(tx, 'insert')
          try {
            return callback(tx)
          } finally {
            sampleInsertCalls.push(...insertSpy.mock.calls.filter(([table]) => table === schema.samples))
            insertSpy.mockRestore()
          }
        })) as typeof instance.db.transaction)

    let response
    try {
      response = await ingest(token, '/api/v1/p/p1/ingest/weight', { dataPoints })
    } finally {
      transactionSpy.mockRestore()
    }

    expect(response.statusCode).toBe(200)
    expect((response.json() as { rowsWritten: number }).rowsWritten).toBe(1)
    expect(sampleInsertCalls).toHaveLength(1)
  })
})

/**
 * A workout point carrying a route, in the shape a phone really sends: `route` is a key on the
 * `exercise` PAYLOAD, not on the point beside it, and it rides a companion dataSource because the
 * Google Health API has no route field at all. Kept in step with
 * packages/core/src/testing/seed.ts's own exercisePoint by hand, which is the same hand-copy
 * weakness that let a misplaced `name` ship once; the wire shape has no schema to generate from.
 */
function workoutWithRoute(o: { name: string, startTime: string, endTime: string, points: number }): Record<string, unknown> {
  return {
    name: o.name,
    dataSource: { platform: 'HEALTH_CONNECT', application: { packageName: 'com.haelan.android' }, device: { displayName: 'Phone' } },
    exercise: {
      interval: { startTime: o.startTime, startUtcOffset: '0s', endTime: o.endTime, endUtcOffset: '0s' },
      exerciseType: 'RUNNING',
      route: Array.from({ length: o.points }, (_, index) => ({
        time: new Date(Date.parse(o.startTime) + index * 1_000).toISOString(),
        latitude: Number((52.1 + index * 0.0001).toFixed(6)),
        longitude: Number((5.1 + index * 0.0001).toFixed(6)),
      })),
    },
  }
}

function routeRows(instance: { db: DbOrTx }): Array<{ id: string, ordinal: number, latitude: number }> {
  return instance.db.select({
    id: schema.sessionRoutes.id,
    ordinal: schema.sessionRoutes.ordinal,
    latitude: schema.sessionRoutes.latitude,
  }).from(schema.sessionRoutes).all()
}

describe('the session route insert statement', () => {
  // The same claim as the samples tests above, for the one table with an unbounded row count: an
  // hour of GPS at 1Hz is about 3,600 points. drizzle prepares a statement on every .run(), and
  // this connection is the server's own, which unlike the rebuild worker never exits to release
  // them - so a per-row prepare here retains for the life of the process. That is the shape that
  // caused the rebuild OOM (#275), and it is what shipped on this branch while replay.ts, the
  // writer this one mirrors, hoisted correctly.
  //
  // Row counts cannot tell the two shapes apart; both write the same rows. The reachable seam is
  // the call into drizzle that prepares one, the same seam the samples tests spy on.
  it('calls tx.insert(schema.sessionRoutes) once for a multi point route, not once per point', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const instance = harness.app.haelan.instance

    const routeInsertCalls: unknown[] = []
    const realTransaction = instance.db.transaction.bind(instance.db)
    const transactionSpy = vi.spyOn(instance.db, 'transaction')
      .mockImplementation(((callback: (tx: DbOrTx) => unknown) =>
        realTransaction((tx) => {
          const insertSpy = vi.spyOn(tx, 'insert')
          try {
            return callback(tx)
          } finally {
            routeInsertCalls.push(...insertSpy.mock.calls.filter(([table]) => table === schema.sessionRoutes))
            insertSpy.mockRestore()
          }
        })) as typeof instance.db.transaction)

    let response
    try {
      response = await ingest(token, '/api/v1/p/p1/ingest/exercise', {
        dataPoints: [workoutWithRoute({
          name: 'run-1', startTime: '2026-08-18T08:00:00Z', endTime: '2026-08-18T09:00:00Z', points: 6,
        })],
      })
    } finally {
      transactionSpy.mockRestore()
    }

    expect(response.statusCode).toBe(200)
    // The control: the six points really were stored, so one insert() call below is hoisting and
    // not a route that quietly failed to map and wrote nothing at all.
    expect(routeRows(instance)).toHaveLength(6)
    expect(routeInsertCalls).toHaveLength(1)
  })
})

describe('a re-uploaded workout replaces its route', () => {
  // SyncCursors.OVERLAP_MS makes the phone re-send a window it has already sent, so a workout
  // arriving twice is routine rather than exceptional. The delete beside the sessions loop is what
  // makes the second arrival replace the first; without it the insert hits
  // `UNIQUE constraint failed: session_routes.id` and the whole upload 500s. Nothing tested that
  // delete when it was written: it could be removed with every test in the repository still green.
  it('accepts the same workout twice and keeps one copy of its route', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const instance = harness.app.haelan.instance
    const workout = {
      name: 'run-1', startTime: '2026-08-18T08:00:00Z', endTime: '2026-08-18T09:00:00Z', points: 4,
    }

    const first = await ingest(token, '/api/v1/p/p1/ingest/exercise', { dataPoints: [workoutWithRoute(workout)] })
    expect(first.statusCode).toBe(200)
    expect(routeRows(instance)).toHaveLength(4)

    const second = await ingest(token, '/api/v1/p/p1/ingest/exercise', { dataPoints: [workoutWithRoute(workout)] })
    expect(second.statusCode, 'the second upload of the same workout was refused').toBe(200)
    expect(routeRows(instance), 'the route was appended to rather than replaced').toHaveLength(4)
  })

  // The other half of "replaced wholesale": a phone that finishes writing a trace to disk sends a
  // LONGER route for the same workout the second time. A delete that ran per arriving point, or an
  // upsert keyed on the point id, would leave the first upload's tail standing behind the second.
  it('drops the points a shorter re-upload no longer carries', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const instance = harness.app.haelan.instance
    const workout = { name: 'run-1', startTime: '2026-08-18T08:00:00Z', endTime: '2026-08-18T09:00:00Z' }

    expect((await ingest(token, '/api/v1/p/p1/ingest/exercise', {
      dataPoints: [workoutWithRoute({ ...workout, points: 9 })],
    })).statusCode).toBe(200)
    expect(routeRows(instance)).toHaveLength(9)

    expect((await ingest(token, '/api/v1/p/p1/ingest/exercise', {
      dataPoints: [workoutWithRoute({ ...workout, points: 3 })],
    })).statusCode).toBe(200)
    const after = routeRows(instance)
    expect(after, 'the superseded tail of the longer first route is still standing').toHaveLength(3)
    expect(after.map((row) => row.ordinal).sort((a, b) => a - b)).toEqual([0, 1, 2])
  })
})

describe('the ingest route during a rebuild', () => {
  // The status matters more than usual here: apps/android's SyncEngine.kt treats any non 401 4xx
  // as a permanent refusal and abandons that data type for good (isWorthRetrying), so this has to
  // land in the set it retries - 429 or 5xx - or a phone syncing during the boot rebuild would
  // silently stop syncing that type forever. 503 through TransientError is what envelope.ts's
  // sendCoreError renders for a 'transient' kind.
  it('answers 503 without writing, while a rebuild is in flight', async () => {
    harness = await withServer({ rebuildInFlight: () => true })
    const token = await harness.signIn()

    const response = await ingest(token, '/api/v1/p/p1/ingest/weight', {
      dataPoints: [samplePoint({
        payloadKey: 'weight', valuePath: 'weightGrams', value: '80000',
        physicalTime: '2026-08-18T10:00:00Z',
      })],
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { kind: 'transient' } })

    const series = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/p/p1/series?metric=weight&agg=last&from=2026-08-18&to=2026-08-18',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(series.statusCode).toBe(200)
    expect((series.json() as { weight: { points: unknown[] } }).weight.points).toEqual([])
  })

  // The control the test above needs: without it, a bug that answered 503 unconditionally would
  // pass the first test for the wrong reason.
  it('writes normally once rebuildInFlight reads false', async () => {
    harness = await withServer({ rebuildInFlight: () => false })
    const token = await harness.signIn()

    const response = await ingest(token, '/api/v1/p/p1/ingest/weight', {
      dataPoints: [samplePoint({
        payloadKey: 'weight', valuePath: 'weightGrams', value: '80000',
        physicalTime: '2026-08-18T10:00:00Z',
      })],
    })
    expect(response.statusCode).toBe(200)
    expect((response.json() as { rowsWritten: number }).rowsWritten).toBe(1)
  })
})

describe('how much derivation an upload does before it answers', () => {
  // A tripwire, not a behavioural proof, and it says so rather than pretending otherwise.
  //
  // What the batch size bounds is the OVERSHOOT: the drain's budget is only checked between
  // batches, so the batch is how far past it one request can run. At the default of eight, a
  // first sync of thirty days of heart rate put eight dense days into a single uninterruptible
  // batch and outran the phone's 30 second read timeout. The phone abandoned a request this
  // server then finished successfully, so nothing logged an error anywhere, the type read "never
  // synced", and every type queued behind it in that run went unattempted. Density decided which
  // ones broke, so the sparse types looked healthy throughout.
  //
  // Asserting that behaviour needs a clock: with cheap days a batch of one still drains the whole
  // queue inside the budget, and only a dense enough day separates the two settings. A timing
  // assertion on a shared runner measures the runner, which this repository keeps relearning. So
  // this reads the call instead and exists to make a later edit meet the paragraph above.
  it('asks for one day per batch on the ingest path', () => {
    const source = readFileSync(new URL('../src/routes/v1/ingest.ts', import.meta.url), 'utf8')
    expect(source).toContain("drainPersonDerivation(app, personId, 'ingest', 1)")
  })
})
