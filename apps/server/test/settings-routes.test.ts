import { describe, it, expect, afterEach } from 'vitest'
import { USER_HORIZON_CHOICES } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const headers = { origin: 'http://localhost:4235', host: 'localhost:4235' }
const DAY_MS = 86_400_000

async function sessionCookie(h: Harness, username = 'bartus'): Promise<string> {
  const response = await h.app.inject({
    method: 'POST', url: '/api/auth/login', headers,
    payload: { username, password: 'a good long password' },
  })
  return response.cookies.find((c) => c.name === 'haelan_session')!.value
}

describe('settings routes', () => {
  it('answers a fully set-up instance rather than 409ing, unlike the /api/setup/* routes the gate closes at done', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const cookie = await sessionCookie(harness)
    const response = await harness.app.inject({
      method: 'GET', url: '/api/settings/backfill-horizon', headers, cookies: { haelan_session: cookie },
    })
    expect(response.statusCode).toBe(200)
    // The body shape is otherwise unasserted anywhere in this suite, and the wizard never calls
    // this GET itself - only the PUT it drives - so nothing else here would catch it drifting.
    expect(response.json()).toMatchObject({ days: 730, choices: [365, 730, 1825] })
  })

  it('accepts each offered horizon and rejects anything else', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const cookie = await sessionCookie(harness)
    for (const days of USER_HORIZON_CHOICES) {
      const ok = await harness.app.inject({
        method: 'PUT', url: '/api/settings/backfill-horizon', headers, cookies: { haelan_session: cookie },
        payload: { days },
      })
      expect(ok.statusCode).toBe(200)
      expect(ok.json()).toMatchObject({ backfillHorizonDays: days })
    }
    // Not a free-text number: an operator typing 20000 would walk past Google's retention for
    // years of empty windows, and the wizard only ever offers three values.
    const rejected = await harness.app.inject({
      method: 'PUT', url: '/api/settings/backfill-horizon', headers, cookies: { haelan_session: cookie },
      payload: { days: 20000 },
    })
    expect(rejected.statusCode).toBe(400)
  })

  it('refuses an unauthenticated caller', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const response = await harness.app.inject({
      method: 'PUT', url: '/api/settings/backfill-horizon', headers, payload: { days: 365 },
    })
    expect(response.statusCode).toBe(401)
  })

  // Instance-wide, not the caller's own: a raise loops every person in the household clearing
  // their backfill-complete marks, which is exactly what requireAdmin's own comment says it
  // exists to gate. requireAdmin answers the {kind,code,message} envelope, not this family's own
  // flat {error} shape - asserted as the guard actually sends it, not as this file's neighbours
  // otherwise answer.
  it('refuses a non-admin caller', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    await harness.addPerson({ id: 'p-outsider', displayName: 'Outsider', username: 'outsider' })
    const cookie = await sessionCookie(harness, 'outsider')
    const response = await harness.app.inject({
      method: 'PUT', url: '/api/settings/backfill-horizon', headers, cookies: { haelan_session: cookie },
      payload: { days: 365 },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: { kind: 'forbidden', code: 'not_admin', message: 'this needs an admin' } })
  })

  it('raising the horizon clears a completed daily type so it walks further on the next run', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const cookie = await sessionCookie(harness)
    const stores = harness.app.haelan.stores
    // Simulates a daily type ('weight') that already reached the default 730 day horizon, the
    // state runBackfill leaves an instance in before an operator ever touches this control.
    const oldFloorMs = harness.clock.nowMs - 730 * DAY_MS
    stores.syncState.setBackfillCursor({ personId: 'p1', dataType: 'weight', cursorMs: oldFloorMs, nowMs: harness.clock.nowMs })
    stores.syncState.markBackfillComplete({ personId: 'p1', dataType: 'weight', nowMs: harness.clock.nowMs })

    const response = await harness.app.inject({
      method: 'PUT', url: '/api/settings/backfill-horizon', headers, cookies: { haelan_session: cookie },
      payload: { days: 1825 },
    })
    expect(response.statusCode).toBe(200)
    // The mark is cleared immediately, before any run happens - re-aiming is what the PUT itself
    // promises, not something a later sync has to remember to do.
    expect(stores.syncState.get('p1', 'weight')?.backfillCompleteAtMs).toBeNull()

    await harness.app.haelan.runner.trigger('manual')
    // Walked strictly past the old floor rather than sitting there silently complete, which is
    // the defect this exists to catch: before clearBackfillComplete existed, runBackfill's early
    // return on an already-complete type meant this PUT changed the number on screen and nothing
    // else.
    expect(stores.syncState.get('p1', 'weight')?.backfillCursorMs).toBeLessThan(oldFloorMs)
  })

  it('lowering the horizon does not clear a completed type, and it settles complete again', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const cookie = await sessionCookie(harness)
    const stores = harness.app.haelan.stores

    // Raise to the top choice first (a no-op clear, since nothing is complete yet), then
    // simulate 'weight' having finished walking all the way to it.
    await harness.app.inject({
      method: 'PUT', url: '/api/settings/backfill-horizon', headers, cookies: { haelan_session: cookie },
      payload: { days: 1825 },
    })
    const deepFloorMs = harness.clock.nowMs - 1825 * DAY_MS
    stores.syncState.setBackfillCursor({ personId: 'p1', dataType: 'weight', cursorMs: deepFloorMs, nowMs: harness.clock.nowMs })
    stores.syncState.markBackfillComplete({ personId: 'p1', dataType: 'weight', nowMs: harness.clock.nowMs })

    const response = await harness.app.inject({
      method: 'PUT', url: '/api/settings/backfill-horizon', headers, cookies: { haelan_session: cookie },
      payload: { days: 365 },
    })
    expect(response.statusCode).toBe(200)
    // Nothing deleted, and lowering never clears: the mark and cursor from the deeper walk
    // survive the PUT untouched.
    const afterPut = stores.syncState.get('p1', 'weight')
    expect(afterPut?.backfillCompleteAtMs).not.toBeNull()
    expect(afterPut?.backfillCursorMs).toBe(deepFloorMs)

    // A run afterwards re-marks it complete rather than erroring - the cursor is already past
    // the new, shallower floor, so runBackfill's own "reached the floor" check settles it again
    // on its very next call, exactly as the spec promises for a lowered horizon.
    await harness.app.haelan.runner.trigger('manual')
    expect(stores.syncState.get('p1', 'weight')?.backfillCompleteAtMs).not.toBeNull()
    expect(stores.syncState.get('p1', 'weight')?.backfillCursorMs).toBe(deepFloorMs)
  })
})
