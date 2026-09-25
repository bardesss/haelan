import { describe, it, expect, afterEach } from 'vitest'
import { schema, DERIVATION_VERSION, samplePoint, TransientError } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }

/** A daily row for one source on one date, the minimum readSourceActivity needs to see it. */
function seedDaily(h: Harness, input: { personId: string, sourceId: string, localDate: string, metric?: string }): void {
  h.app.haelan.instance.db.insert(schema.daily).values({
    personId: input.personId, localDate: input.localDate,
    metric: input.metric ?? 'steps', agg: 'sum', source: input.sourceId, value: 1000, coverage: 0.9,
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

  it('names what a stale device reported routinely, and nothing for one still reporting', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const token = await harness.signIn()
    seedSource(harness, 'p1', 'watch')
    seedSource(harness, 'p1', 'scale')
    // Synthetic: a watch reporting steps and heart rate daily through 2026-01-12, then silent for
    // three weeks (past its 14 day floor, inside the panel's 30 day default), with one workout in
    // its final week that is not routine. The scale reported today.
    for (let day = 1; day <= 20; day += 1) {
      const localDate = new Date(Date.UTC(2025, 11, 23 + day)).toISOString().slice(0, 10)
      seedDaily(harness, { personId: 'p1', sourceId: 'watch', localDate, metric: 'steps' })
      seedDaily(harness, { personId: 'p1', sourceId: 'watch', localDate, metric: 'heart_rate' })
    }
    seedDaily(harness, { personId: 'p1', sourceId: 'watch', localDate: '2026-01-10', metric: 'workout_count' })
    seedDaily(harness, { personId: 'p1', sourceId: 'scale', localDate: TODAY, metric: 'weight' })

    const response = await status(harness, token)
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      connections: { devices: { sourceId: string, lastReportedDate: string, stale: boolean, metrics: string[] }[] }[]
    }
    expect(body.connections[0]!.devices.map((d) => [d.sourceId, d.lastReportedDate, d.stale, d.metrics])).toEqual([
      ['scale', TODAY, false, []],
      ['watch', '2026-01-12', true, ['heart_rate', 'steps']],
    ])
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

  // The gap the review found: a row that is BOTH revoked and undecryptable (a revoked grant, then
  // a backup restored without instance.key). isCredentialsUnreadable and isConnected both return
  // false the moment revokedAtMs is set, before ever attempting to decrypt - so this row reaches
  // the third branch of the ternary in status.ts, which used to read
  // getRefreshToken(personId)?.revokedAtMs and would throw CredentialsUnreadableError instead of
  // answering. That throw is unhandled here: this route sits outside registerV1's error handler,
  // so it would have surfaced as a 500, not the 'revoked' problem this test wants.
  it('reports revoked, not a 500, for a connection that is revoked AND undecryptable', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const token = await harness.signIn()
    harness.app.haelan.instance.credentials.markRevoked('p1', harness.clock.nowMs)
    // Corrupts the stored ciphertext directly, the same state a backup restored without
    // instance.key leaves a still-revoked row in: nothing sealed by this instance's own key can
    // read it back.
    harness.app.haelan.instance.db.$client
      .prepare("update credentials set refresh_token_encrypted = 'not valid ciphertext' where person_id = 'p1'")
      .run()

    const response = await status(harness, token)
    expect(response.statusCode).toBe(200)
    const body = response.json() as { connections: { kind: string, problem: string | null }[] }
    const google = body.connections.find((c) => c.kind === 'google')
    expect(google?.problem).toBe('revoked')
  })

  // The bug: run.lastFailed used to be passed straight through - the last run's instance-wide
  // failure count across everyone it synced - so a housemate's failing sync marked THIS person's
  // Google row 'sync_failed' too. Person A has a failing sync_state row of their own and should
  // see 'sync_failed'; person B, signed in separately with no failing row, should not, even
  // though the persisted run (shared across the instance) reports a nonzero failure count.
  it("reports sync_failed from the caller's own failing sync, not a housemate's", async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const tokenA = await harness.signIn()
    await harness.addPerson({ id: 'p2', displayName: 'Other', username: 'other' })
    // Person B has their own Google connection too, so their status also carries a 'google'
    // connection - just one with no failing sync_state row of its own.
    harness.app.haelan.instance.credentials.putRefreshToken({
      personId: 'p2', refreshToken: 'stub-refresh-token-2', scopes: [], nowMs: harness.clock.nowMs,
    })
    const tokenB = await harness.signIn('other', 'a good long password')

    // Person A's own sync_state has a failing type.
    harness.app.haelan.stores.syncState.recordFailure({
      personId: 'p1', dataType: 'steps', error: new TransientError('nope'), nowMs: harness.clock.nowMs,
    })
    // The persisted, instance-wide last run reports a failure count too - the figure the old code
    // read directly, which used to leak into every person's row regardless of whose sync failed.
    harness.app.haelan.stores.settings.putLastSync(
      { finishedAtMs: harness.clock.nowMs, rowsWritten: 10, failed: 1 }, harness.clock.nowMs,
    )

    const responseA = await status(harness, tokenA)
    expect(responseA.statusCode).toBe(200)
    const googleA = (responseA.json() as { connections: { kind: string, problem: string | null }[] })
      .connections.find((c) => c.kind === 'google')
    expect(googleA?.problem).toBe('sync_failed')

    const responseB = await status(harness, tokenB)
    expect(responseB.statusCode).toBe(200)
    const googleB = (responseB.json() as { connections: { kind: string, problem: string | null }[] })
      .connections.find((c) => c.kind === 'google')
    expect(googleB?.problem).toBeNull()
  })

  // "Part of the last sync failed" named nothing. The per-type failures were in sync_state all
  // along; this is the route handing them to the panel, per person like the count above, so a
  // housemate's failing types never appear in this person's list.
  it("lists the caller's own failing data types on the Google connection, newest first", async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const tokenA = await harness.signIn()
    await harness.addPerson({ id: 'p2', displayName: 'Other', username: 'other' })
    harness.app.haelan.instance.credentials.putRefreshToken({
      personId: 'p2', refreshToken: 'stub-refresh-token-2', scopes: [], nowMs: harness.clock.nowMs,
    })
    const tokenB = await harness.signIn('other', 'a good long password')
    const syncState = harness.app.haelan.stores.syncState
    const now = harness.clock.nowMs
    syncState.recordFailure({ personId: 'p1', dataType: 'steps', error: new TransientError('503 listing steps'), nowMs: now - 2000 })
    syncState.recordFailure({ personId: 'p1', dataType: 'weight', error: new TransientError('503 listing weight'), nowMs: now - 1000 })
    syncState.recordFailure({ personId: 'p2', dataType: 'sleep', error: new TransientError('not yours'), nowMs: now })

    type Body = { connections: { kind: string, failures?: { dataType: string, lastError: string | null, lastErrorAtMs: number | null }[] }[] }
    const bodyA = (await status(harness, tokenA)).json() as Body
    expect(bodyA.connections.find((c) => c.kind === 'google')?.failures).toEqual([
      { dataType: 'weight', lastError: '[transient] 503 listing weight', lastErrorAtMs: now - 1000 },
      { dataType: 'steps', lastError: '[transient] 503 listing steps', lastErrorAtMs: now - 2000 },
    ])
    const bodyB = (await status(harness, tokenB)).json() as Body
    expect(bodyB.connections.find((c) => c.kind === 'google')?.failures?.map((f) => f.dataType)).toEqual(['sleep'])
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
