import { describe, it, expect, afterEach } from 'vitest'
import { schema, DERIVATION_VERSION } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

// Sources whose data carries no device name are named after the app's package (sources.ts's
// describe()), and those raw ids used to be what /sources and /api/status sent as `name`. These
// pin the readable default on both routes, with the key the web localises from beside it.
// Synthetic sources only: real package names, made-up hashes and ids.

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// The harness clock is 2026-02-02 in Europe/Amsterdam; the sources below were first seen a few
// weeks earlier, and every one reports today so the status panel lists it by default.
const TODAY = '2026-02-02'
const JAN_4 = Date.UTC(2026, 0, 4, 12)
const JAN_20 = Date.UTC(2026, 0, 20, 12)

const HC_A = 'com.android.healthconnect.phone.0a1b2c3d'
const HC_B = 'com.android.healthconnect.phone.9f8e7d6c'

function seed(h: Harness): void {
  const db = h.app.haelan.instance.db
  db.insert(schema.sources).values([
    { id: 'haelan', personId: 'p1', externalId: 'HEALTH_CONNECT:com.haelan.android', displayName: 'com.haelan.android', kind: 'app', createdAtMs: JAN_4 },
    { id: 'scale', personId: 'p1', externalId: 'HEALTH_CONNECT:health.openscale.sync.oss', displayName: 'health.openscale.sync.oss', kind: 'app', createdAtMs: JAN_4 },
    { id: 'hcA', personId: 'p1', externalId: `HEALTH_CONNECT:${HC_A}`, displayName: HC_A, kind: 'app', createdAtMs: JAN_4 },
    { id: 'hcB', personId: 'p1', externalId: `HEALTH_CONNECT:${HC_B}`, displayName: HC_B, kind: 'app', createdAtMs: JAN_20 },
    { id: 'lyfta', personId: 'p1', externalId: 'HEALTH_CONNECT:com.lyfta', displayName: 'com.lyfta', kind: 'app', createdAtMs: JAN_4 },
  ]).run()
  for (const source of ['haelan', 'scale', 'hcA', 'hcB', 'lyfta']) {
    db.insert(schema.daily).values({
      personId: 'p1', localDate: TODAY, metric: 'steps', agg: 'sum', source, value: 1000, coverage: 0.9,
      sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
  }
}

const EXPECTED: Record<string, [string, unknown]> = {
  haelan: ['Haelan (phone)', { key: 'haelanPhone', since: null, tag: null }],
  scale: ['openScale', { key: 'openScale', since: null, tag: null }],
  hcA: ['Health Connect (phone), since 4 Jan 2026', { key: 'healthConnectPhone', since: '2026-01-04', tag: null }],
  hcB: ['Health Connect (phone), since 20 Jan 2026', { key: 'healthConnectPhone', since: '2026-01-20', tag: null }],
  lyfta: ['com.lyfta', null],
}

describe('readable default source names', () => {
  it('GET /sources names known apps readably, and an alias still wins', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    seed(harness)
    const auth = { authorization: `Bearer ${token}` }

    const listed = await harness.app.inject({ method: 'GET', url: '/api/v1/p/p1/sources', headers: auth })
    expect(listed.statusCode).toBe(200)
    const items = listed.json().items as { id: string, name: string, defaultName: unknown }[]
    expect(Object.fromEntries(items.map((s) => [s.id, [s.name, s.defaultName]]))).toEqual(EXPECTED)

    const renamed = await harness.app.inject({
      method: 'PUT', url: '/api/v1/p/p1/sources/hcB/alias',
      headers: { ...auth, 'content-type': 'application/json' }, payload: { alias: 'Old phone' },
    })
    expect(renamed.statusCode).toBe(200)
    const after = (await harness.app.inject({ method: 'GET', url: '/api/v1/p/p1/sources', headers: auth }))
      .json().items as { id: string, name: string }[]
    const named = Object.fromEntries(after.map((s) => [s.id, s.name]))
    expect(named['hcB']).toBe('Old phone')
    // Alone under the default now, so it loses its date.
    expect(named['hcA']).toBe('Health Connect (phone)')
  })

  it('GET /api/status names the panel rows the same way, with no default beside an alias', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const token = await harness.signIn()
    seed(harness)
    harness.app.haelan.instance.sourceAliases.put({ personId: 'p1', sourceId: 'haelan', alias: 'My phone', nowMs: 0 })

    const response = await harness.app.inject({ method: 'GET', url: '/api/status', headers: { authorization: `Bearer ${token}` } })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { connections: { devices: { sourceId: string, name: string, defaultName: unknown }[] }[] }
    const devices = body.connections.flatMap((c) => c.devices)
    expect(Object.fromEntries(devices.map((d) => [d.sourceId, [d.name, d.defaultName]]))).toEqual({
      ...EXPECTED,
      // A panel row has no alias field to check first, so it is sent no default to outrank it.
      haelan: ['My phone', null],
    })
  })
})
