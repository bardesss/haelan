import { describe, it, expect, afterEach, vi } from 'vitest'
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
