import { describe, it, expect, afterEach, vi } from 'vitest'
import { samplePoint, schema, sleepPoint } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'
import { rebuildIfNeeded } from '../src/rebuild.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }
const MAX_DELETIONS = 1_000

const weightAt = (physicalTime: string, name: string, grams = '80000') => ({
  ...samplePoint({ payloadKey: 'weight', valuePath: 'weightGrams', value: grams, physicalTime }),
  name,
})

const nightPoint = () => ({
  ...sleepPoint({
    startTime: '2026-08-17T21:30:00Z',
    endTime: '2026-08-18T05:15:00Z',
    stages: [
      { type: 'LIGHT', startTime: '2026-08-17T21:30:00Z', endTime: '2026-08-17T22:30:00Z' },
      { type: 'DEEP', startTime: '2026-08-17T22:30:00Z', endTime: '2026-08-18T00:30:00Z' },
      { type: 'REM', startTime: '2026-08-18T00:30:00Z', endTime: '2026-08-18T02:00:00Z' },
      { type: 'AWAKE', startTime: '2026-08-18T02:00:00Z', endTime: '2026-08-18T02:10:00Z' },
      { type: 'LIGHT', startTime: '2026-08-18T02:10:00Z', endTime: '2026-08-18T05:15:00Z' },
    ],
  }),
  name: 'hc-night-1',
})

async function post(token: string, path: string, payload: Record<string, unknown>) {
  if (!harness) throw new Error('no harness')
  return harness.app.inject({
    method: 'POST', url: path,
    headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    payload,
  })
}

const ingest = (token: string, type: string, dataPoints: unknown[]) =>
  post(token, `/api/v1/p/p1/ingest/${type}`, { dataPoints })
const remove = (token: string, type: string, recordIds: unknown, person = 'p1') =>
  post(token, `/api/v1/p/${person}/ingest/${type}/deletions`, { recordIds: recordIds as string[] })

describe('the companion deletions route', () => {
  it('deleting a weight by its record id removes it and re-derives its day', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    await ingest(token, 'weight', [weightAt('2026-08-18T07:00:00Z', 'hc-weight-1')])
    const db = harness.app.haelan.instance.db
    expect(db.select().from(schema.samples).all()).toHaveLength(1)

    const response = await remove(token, 'weight', ['hc-weight-1'])
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      rowsWritten: 0, rowsDeleted: 1, affected: { from: '2026-08-18', to: '2026-08-18' }, applied: true,
    })
    expect(db.select().from(schema.samples).all()).toEqual([])
  })

  // A characterization: ingest files by the record's own instant already, so this passes before
  // the deletions route exists. It pins what the phone's change feed relies on.
  it('a backdated weight sent a week late lands on its own day', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    await ingest(token, 'weight', [weightAt('2026-08-25T07:00:00Z', 'hc-weight-2')])
    const response = await ingest(token, 'weight', [weightAt('2026-08-18T07:00:00Z', 'hc-weight-1')])
    expect(response.json()).toMatchObject({ affected: { from: '2026-08-18', to: '2026-08-18' } })
    const series = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/p/p1/series?metric=weight&agg=last&from=2026-08-18&to=2026-08-18',
      headers: { authorization: `Bearer ${token}` },
    })
    const points = (series.json() as { weight: { points: { localDate: string }[] } }).weight.points
    expect(points.map((p) => p.localDate)).toEqual(['2026-08-18'])
  })

  it('a weight moved at the source leaves its old day and re-derives it', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    await ingest(token, 'weight', [weightAt('2026-08-17T07:00:00Z', 'hc-weight-1')])
    const response = await ingest(token, 'weight', [weightAt('2026-08-21T07:00:00Z', 'hc-weight-1')])
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ affected: { from: '2026-08-17', to: '2026-08-21' }, applied: true })
    const series = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/p/p1/series?metric=weight&agg=last&from=2026-08-17&to=2026-08-21',
      headers: { authorization: `Bearer ${token}` },
    })
    const points = (series.json() as { weight: { points: { localDate: string }[] } }).weight.points
    expect(points.map((p) => p.localDate)).toEqual(['2026-08-21'])
  })

  it('deleting a night removes the session', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    await ingest(token, 'sleep', [nightPoint()])
    const nightsUrl = '/api/v1/p/p1/sleep/nights?from=2026-08-18&to=2026-08-18'
    const list = () => harness!.app.inject({ method: 'GET', url: nightsUrl, headers: { authorization: `Bearer ${token}` } })
    expect((await list()).json().items).toHaveLength(1)

    const response = await remove(token, 'sleep', ['hc-night-1'])
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ rowsWritten: 0, rowsDeleted: 1, affected: { from: '2026-08-18', to: '2026-08-18' } })
    expect((await list()).json().items).toEqual([])
  })

  it('deleting a night marks its neighbour dates dirty too', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    await ingest(token, 'sleep', [nightPoint()])
    const queue = harness.app.haelan.instance.deriveQueue
    const marks: { localDate: string, nowMs: number }[] = []
    const markDirty = queue.markDirty.bind(queue)
    vi.spyOn(queue, 'markDirty').mockImplementation((input, tx) => {
      marks.push({ localDate: input.localDate, nowMs: input.nowMs })
      markDirty(input, tx)
    })

    const response = await remove(token, 'sleep', ['hc-night-1'])
    expect(response.json()).toMatchObject({ affected: { from: '2026-08-18', to: '2026-08-18' } })
    const own = marks.filter((m) => m.localDate === '2026-08-18')
    const neighbours = marks.filter((m) => m.localDate !== '2026-08-18')
    expect(neighbours.map((m) => m.localDate).sort()).toEqual(['2026-08-17', '2026-08-19'])
    expect(own).toHaveLength(1)
    for (const m of neighbours) expect(m.nowMs).toBeGreaterThan(own[0]!.nowMs)
  })

  // An app re-writing an entry as delete A, insert B at the same instant: B's upsert lands on
  // A's row, and A's deletion, posted after it in the same drain, must not take it.
  it('deleting a record keeps the row a surviving record wrote on the same key', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    await ingest(token, 'weight', [weightAt('2026-08-18T07:00:00Z', 'hc-weight-a')])
    await ingest(token, 'weight', [{
      ...samplePoint({ payloadKey: 'weight', valuePath: 'weightGrams', value: '81000', physicalTime: '2026-08-18T07:00:00Z' }),
      name: 'hc-weight-b',
    }])
    const response = await remove(token, 'weight', ['hc-weight-a'])
    expect(response.json()).toMatchObject({ rowsDeleted: 0, affected: null })
    const db = harness.app.haelan.instance.db
    expect(db.select().from(schema.samples).all().map((r) => r.value)).toEqual([81000])
  })

  it('answers an unknown record id with nothing deleted', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const response = await remove(token, 'weight', ['hc-never-seen'])
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ rowsWritten: 0, rowsDeleted: 0, affected: null, applied: true })
  })

  it('refuses an empty list, a blank id, and one id more than the maximum', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    expect((await remove(token, 'weight', [])).statusCode).toBe(400)
    expect((await remove(token, 'weight', ['hc-weight-1', ''])).statusCode).toBe(400)
    const tooMany = Array.from({ length: MAX_DELETIONS + 1 }, (_, i) => `hc-weight-${i}`)
    expect((await remove(token, 'weight', tooMany)).statusCode).toBe(400)
  })

  it('refuses another person', async () => {
    harness = await withServer()
    await harness.addPerson({ id: 'p2', displayName: 'Someone else', username: 'other' })
    const token = await harness.signIn()
    const response = await remove(token, 'weight', ['hc-weight-1'], 'p2')
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { kind: 'forbidden', code: 'not_your_person' } })
  })

  it('answers 503 during a rebuild', async () => {
    harness = await withServer({ rebuildInFlight: () => true })
    const token = await harness.signIn()
    const response = await remove(token, 'weight', ['hc-weight-1'])
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { kind: 'transient' } })
  })
})

describe('a rebuild after companion moves ends where live did', () => {
  // Samples and links as live left them, then as a forced rebuild leaves them. One source
  // throughout, and a rebuild hands out its ref afresh, so the ref is left out.
  async function liveThenRebuilt(): Promise<{ live: unknown, rebuilt: unknown }> {
    if (!harness) throw new Error('no harness')
    const db = harness.app.haelan.instance.db
    const snapshot = () => ({
      samples: db.select().from(schema.samples).all()
        .map((r) => ({ ...r, sourceRef: undefined, rawPayloadRef: undefined }))
        .sort((a, b) => a.utcMs - b.utcMs),
      links: db.select().from(schema.companionRecordSamples).all()
        .map((l) => ({ ...l, sourceRef: undefined }))
        .sort((a, b) => (a.recordId < b.recordId ? -1 : 1)),
    })
    const live = snapshot()
    db.update(schema.people).set({ builtMappingVersion: null, builtDerivationVersion: null }).run()
    await rebuildIfNeeded({ instance: harness.app.haelan.instance, nowMs: () => Date.now(), log: () => {} })
    return { live, rebuilt: snapshot() }
  }

  it('a weight moved away and back again, the last upload identical to the first', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const monday = [weightAt('2026-08-17T07:00:00Z', 'hc-weight-1')]
    for (const dataPoints of [monday, [weightAt('2026-08-21T07:00:00Z', 'hc-weight-1')], monday]) {
      expect((await ingest(token, 'weight', dataPoints)).statusCode).toBe(200)
      harness.clock.nowMs += 60_000
    }
    const { live, rebuilt } = await liveThenRebuilt()
    expect((live as { samples: { utcMs: number }[] }).samples.map((r) => r.utcMs))
      .toEqual([Date.parse('2026-08-17T07:00:00Z')])
    expect(rebuilt).toEqual(live)
  })

  it('a weight deleted and then restored under the same id at another time', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    expect((await ingest(token, 'weight', [weightAt('2026-08-17T07:00:00Z', 'hc-weight-1')])).statusCode).toBe(200)
    harness.clock.nowMs += 60_000
    expect((await remove(token, 'weight', ['hc-weight-1'])).statusCode).toBe(200)
    harness.clock.nowMs += 60_000
    expect((await ingest(token, 'weight', [weightAt('2026-08-18T07:00:00Z', 'hc-weight-1', '81000')])).statusCode).toBe(200)
    const { live, rebuilt } = await liveThenRebuilt()
    expect((live as { samples: { utcMs: number }[] }).samples.map((r) => r.utcMs))
      .toEqual([Date.parse('2026-08-18T07:00:00Z')])
    expect(rebuilt).toEqual(live)
  })
})
