import { describe, it, expect, afterEach } from 'vitest'
import { USER_HORIZON_CHOICES } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const headers = { origin: 'http://localhost:4235', host: 'localhost:4235' }

async function sessionCookie(h: Harness): Promise<string> {
  const response = await h.app.inject({
    method: 'POST', url: '/api/auth/login', headers,
    payload: { username: 'bartus', password: 'a good long password' },
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
})
