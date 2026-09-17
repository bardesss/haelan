import { describe, it, expect, afterEach } from 'vitest'
import { RawArchive, SCOPES, samplePoint } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'
import { companionIngestibleIds } from '../src/routes/v1/companion.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }

const weightPoint = (time: string) => samplePoint({
  payloadKey: 'weight',
  valuePath: 'weightGrams',
  value: '80000',
  physicalTime: time,
})

async function ingest(token: string, dataTypeId: string, payload: Record<string, unknown>) {
  if (!harness) throw new Error('no harness')
  return harness.app.inject({
    method: 'POST', url: `/api/v1/p/p1/ingest/${dataTypeId}`,
    headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    payload,
  })
}

async function cursors(token: string, query = '') {
  if (!harness) throw new Error('no harness')
  return harness.app.inject({
    method: 'GET', url: `/api/v1/p/p1/companion/cursors${query}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

interface CursorItem { dataTypeId: string, lastWindowEndMs: number | null, lastIngestAtMs: number | null }

describe('GET /companion/cursors', () => {
  it('answers null for every ingestible type before the first sync', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const response = await cursors(token, '?platform=android')
    expect(response.statusCode).toBe(200)
    const body = response.json() as { items: CursorItem[], historyStartMs: number | null }
    expect(body.historyStartMs).toBe(null)
    expect(body.items.map((i) => i.dataTypeId)).toEqual(companionIngestibleIds())
    expect(body.items.every((i) => i.lastWindowEndMs === null && i.lastIngestAtMs === null)).toBe(true)
  })

  it('moves only the ingested type and records the history start', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    expect((await ingest(token, 'weight', { dataPoints: [weightPoint('2026-08-18T10:00:00Z')] })).statusCode).toBe(200)

    const body = (await cursors(token)).json() as { items: CursorItem[], historyStartMs: number | null }
    const weight = body.items.find((i) => i.dataTypeId === 'weight')
    const steps = body.items.find((i) => i.dataTypeId === 'steps')
    // The archive stores an exclusive end, one millisecond past the sample (ingest.ts).
    expect(weight?.lastWindowEndMs).toBe(Date.parse('2026-08-18T10:00:00Z') + 1)
    expect(typeof weight?.lastIngestAtMs).toBe('number')
    expect(steps?.lastWindowEndMs).toBe(null)
    expect(body.historyStartMs).toBe(Date.parse('2026-08-18T10:00:00Z'))
  })

  it('keeps the newest window end and the newest fetch time across two uploads', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    expect((await ingest(token, 'weight', { dataPoints: [weightPoint('2026-08-18T10:00:00Z')] })).statusCode).toBe(200)
    harness.clock.nowMs += 3_600_000
    expect((await ingest(token, 'weight', { dataPoints: [weightPoint('2026-08-20T10:00:00Z')] })).statusCode).toBe(200)

    const body = (await cursors(token)).json() as { items: CursorItem[], historyStartMs: number | null }
    const weight = body.items.find((i) => i.dataTypeId === 'weight')
    expect(weight?.lastWindowEndMs).toBe(Date.parse('2026-08-20T10:00:00Z') + 1)
    expect(body.historyStartMs).toBe(Date.parse('2026-08-18T10:00:00Z'))
  })

  it('ignores Google fetches archived for the same person and type', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    if (!harness) throw new Error('no harness')
    new RawArchive(harness.app.haelan.instance.db).put({
      personId: 'p1',
      dataType: 'weight',
      requestParams: { filter: 'weight.sample_time.physical_time >= "2026-08-10T00:00:00Z"', pageSize: 10000, pageToken: null },
      windowStartMs: Date.parse('2026-08-10T00:00:00Z'),
      windowEndMs: Date.parse('2026-08-11T00:00:00Z'),
      fetchedAtMs: harness.clock.nowMs,
      httpStatus: 200,
      body: JSON.stringify({ dataPoints: [weightPoint('2026-08-10T10:00:00Z')] }),
    })
    const body = (await cursors(token)).json() as { items: CursorItem[], historyStartMs: number | null }
    expect(body.items.find((i) => i.dataTypeId === 'weight')?.lastWindowEndMs).toBe(null)
    expect(body.historyStartMs).toBe(null)
  })

  it('accepts the platform spellings the phone may send and refuses an unknown one', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    for (const query of ['', '?platform=android', '?platform=HEALTH_CONNECT', '?platform=health-connect']) {
      expect((await cursors(token, query)).statusCode).toBe(200)
    }
    const refused = await cursors(token, '?platform=healthkit')
    expect(refused.statusCode).toBe(400)
  })

  it('names whether the person also has a Google path, so cards know when to clamp', async () => {
    harness = await withServer()
    // T6.0: the harness finishes the wizard with a Google path for p1, so the unconnected
    // case needs a member of its own: addPerson creates one with no token behind it.
    const added = await harness.addPerson({ id: 'p2', displayName: 'Other', username: 'other' })
    const token = await harness.signIn('other', 'a good long password')
    const forPerson = (personId: string) => {
      if (!harness) throw new Error('no harness')
      return harness.app.inject({
        method: 'GET', url: `/api/v1/p/${personId}/companion/cursors`,
        headers: { authorization: `Bearer ${token}` },
      })
    }
    expect(((await forPerson(added.personId)).json() as { googleConnected: boolean }).googleConnected).toBe(false)
    harness.app.haelan.instance.credentials.putRefreshToken({
      personId: added.personId, refreshToken: 'stub-refresh-token',
      scopes: [...SCOPES], nowMs: harness.clock.nowMs,
    })
    expect(((await forPerson(added.personId)).json() as { googleConnected: boolean }).googleConnected).toBe(true)
  })

  it('cannot be read for another person', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const other = await harness.addPerson({ id: 'p2', displayName: 'Other', username: 'other' })
    const response = await harness.app.inject({
      method: 'GET', url: `/api/v1/p/${other.personId}/companion/cursors`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
  })
})
