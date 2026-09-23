import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

async function get(h: Harness, token: string, path: string) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/p/p1${path}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('GET /api/v1/p/:personId/glance', () => {
  it('answers the glance for the person\'s own today, in their own zone', async () => {
    harness = await withServer()
    // 23:30 UTC on 19 August is already 20 August in Europe/Amsterdam, every harness person's zone.
    // Set before signIn so the session's own expiry is stamped from the same instant the request
    // below runs at, rather than from the harness's default clock thirty-plus days earlier.
    harness.clock.nowMs = Date.parse('2026-08-19T23:30:00Z')
    const token = await harness.signIn()
    const reply = await get(harness, token, '/glance')
    expect(reply.statusCode).toBe(200)
    const body = reply.json()
    expect(body.today).toBe('2026-08-20')
    expect(body.generatedAtMs).toBe(harness.clock.nowMs)
    expect(body).toHaveProperty('recovery.index')
    expect(body).toHaveProperty('day.steps')
  })

  it('names a stale source by the name the person gave it', async () => {
    harness = await withServer()
    // Set before signIn for the same reason the first case does.
    harness.clock.nowMs = Date.parse('2026-08-20T08:00:00Z')
    const token = await harness.signIn()
    const db = harness.app.haelan.instance.db
    db.insert(schema.sources).values({ id: 'w1', personId: 'p1', externalId: 'w1', displayName: 'FITBIT', kind: 'device', createdAtMs: 0 }).run()
    harness.app.haelan.instance.sourceAliases.put({ personId: 'p1', sourceId: 'w1', alias: 'My watch', nowMs: harness.clock.nowMs })
    const row = (localDate: string, source: string, sourceMix: string | null) => db.insert(schema.daily).values({
      personId: 'p1', localDate, metric: 'steps', agg: 'sum', source, value: 1000, coverage: 1, sourceMix,
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
    for (let d = 1; d <= 31; d += 1) row(`2026-07-${String(d).padStart(2, '0')}`, 'w1', null)
    row('2026-08-19', 'merged', JSON.stringify([{ source: 'w1', share: 1 }]))
    const body = (await get(harness, token, '/glance')).json()
    expect(body.day.steps.staleSources).toEqual([expect.objectContaining({ sourceId: 'w1', name: 'My watch' })])
  })
})
