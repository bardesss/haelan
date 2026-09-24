import { describe, it, expect, afterEach } from 'vitest'
import { schema, DERIVATION_VERSION, samplePoint } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }

/** A daily row for one source on one date, the minimum readSourceActivity needs to see it. */
function seedDaily(h: Harness, input: { personId: string, sourceId: string, localDate: string }): void {
  h.app.haelan.instance.db.insert(schema.daily).values({
    personId: input.personId, localDate: input.localDate,
    metric: 'steps', agg: 'sum', source: input.sourceId, value: 1000, coverage: 0.9,
    sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
  }).run()
}

function seedSource(h: Harness, personId: string, sourceId: string): void {
  h.app.haelan.instance.db.insert(schema.sources).values({
    id: sourceId, personId, externalId: sourceId, displayName: sourceId, kind: 'device', createdAtMs: 0,
  }).run()
}

// The harness clock sits at 1_770_000_000_000ms, which is 2026-02-02 in Europe/Amsterdam - the
// same "today" v1-sources.test.ts's own activity tests rely on, and every harness person's zone.
const TODAY = '2026-02-02'

async function status(h: Harness, token: string) {
  return h.app.inject({ method: 'GET', url: '/api/status', headers: { authorization: `Bearer ${token}` } })
}

describe('GET /api/status', () => {
  it('answers 401 without a session, because it names the data types and devices a person has', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    expect((await harness.app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(401)
  })

  it('lists a Google connection with its devices for a connected person', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const token = await harness.signIn()
    seedSource(harness, 'p1', 'watch')
    seedDaily(harness, { personId: 'p1', sourceId: 'watch', localDate: TODAY })

    const response = await status(harness, token)
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      connections: { kind: string, devices: { sourceId: string }[] }[]
      sync: { running: boolean, cooldownRemainingMs: number }
    }
    expect(body.connections.map((c) => c.kind)).toEqual(['google'])
    expect(body.connections[0]!.devices.map((d) => d.sourceId)).toEqual(['watch'])
    expect(body.sync).toMatchObject({ running: false, cooldownRemainingMs: 0 })
  })

  it('attributes a companion-uploaded source to the phone', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const weightPoint = samplePoint({
      payloadKey: 'weight', valuePath: 'weightGrams', value: '80000',
      physicalTime: `${TODAY}T10:00:00Z`,
    })
    const ingested = await harness.app.inject({
      method: 'POST', url: '/api/v1/p/p1/ingest/weight',
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      payload: { dataPoints: [weightPoint] },
    })
    expect(ingested.statusCode).toBe(200)

    const response = await status(harness, token)
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      connections: { kind: string, lastDeliveryAtMs: number | null, devices: unknown[] }[]
    }
    const phone = body.connections.find((c) => c.kind === 'phone')
    expect(phone).toBeDefined()
    expect(phone!.lastDeliveryAtMs).toBe(harness.clock.nowMs)
    expect(phone!.devices).toHaveLength(1)
  })

  it("never shows another person's sources", async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const token = await harness.signIn()
    const other = await harness.addPerson({ id: 'p2', displayName: 'Other', username: 'other' })
    seedSource(harness, other.personId, 'their-watch')
    seedDaily(harness, { personId: other.personId, sourceId: 'their-watch', localDate: TODAY })

    const response = await status(harness, token)
    expect(response.statusCode).toBe(200)
    const body = response.json() as { connections: { devices: { sourceId: string }[] }[] }
    const allSourceIds = body.connections.flatMap((c) => c.devices.map((d) => d.sourceId))
    expect(allSourceIds).not.toContain('their-watch')
  })
})
