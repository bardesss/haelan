import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore, SCOPES, SettingsStore, body, openHaelan, seedPerson } from '@haelan/core'
import type { RateLimiter } from '@haelan/core'
import { buildServer } from '../src/app.ts'
import type { FastifyInstance } from 'fastify'

export type GoogleMode = 'ok' | 'redirect_uri_mismatch' | 'service_disabled'

export interface WithServerOptions {
  google?: GoogleMode
  /** Replaces the pass through limiter, so a test can park a run mid flight and release it. */
  limiter?: RateLimiter
}

const GOOGLE_STUB_ROOT = 'http://stub.invalid'

// Answers the two endpoints the consent round trip touches, by URL, so no test ever reaches
// Google. Anything else throws rather than returning a plausible empty answer.
function stubFetch(mode: GoogleMode): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/token')) {
      if (mode === 'redirect_uri_mismatch') {
        return new Response(JSON.stringify({ error: 'redirect_uri_mismatch' }), { status: 400 })
      }
      return new Response(JSON.stringify({
        refresh_token: 'stub-refresh-token', access_token: 'stub-access-token',
        expires_in: 3599, scope: SCOPES.join(' '),
      }), { status: 200 })
    }
    if (url.endsWith('/users/me/profile')) {
      if (mode === 'service_disabled') {
        return new Response(JSON.stringify({
          error: {
            status: 'PERMISSION_DENIED',
            message: 'Health API has not been used in project 1 before or it is disabled',
            details: [{ reason: 'SERVICE_DISABLED' }],
          },
        }), { status: 403 })
      }
      return new Response(JSON.stringify({ displayName: 'Bartus' }), { status: 200 })
    }
    // An empty page in the shape the mappers expect. These tests are about the runner's
    // scheduling and progress, not its mapping; Task 16's end to end run is where real points
    // travel through and land as rows.
    if (url.includes('/dataPoints')) return new Response(body([]), { status: 200 })
    throw new Error(`the stub was asked for ${url}, which it does not serve`)
  }) as unknown as typeof globalThis.fetch
}

export interface Harness {
  app: FastifyInstance
  dir: string
  clock: { nowMs: number }
  completeSetup: () => Promise<void>
  connectPerson: () => Promise<void>
  cleanup: () => Promise<void>
}

export async function withServer(options: WithServerOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-server-'))
  const clock = { nowMs: 1_770_000_000_000 }
  const instance = openHaelan(dir, {})
  const app = buildServer({
    instance,
    now: () => clock.nowMs,
    fetch: options.google
      ? stubFetch(options.google)
      : async () => { throw new Error('no stub fetch installed for this test') },
    ...(options.google
      ? {
          endpoints: {
            apiRoot: `${GOOGLE_STUB_ROOT}/v4`,
            tokenEndpoint: `${GOOGLE_STUB_ROOT}/token`,
            authEndpoint: `${GOOGLE_STUB_ROOT}/auth`,
          },
        }
      : {}),
    // A pass through, because these tests drive hundreds of stubbed windows and the real
    // bucket refills against the wall clock. Rate limiting is exercised by TokenBucket's own
    // tests; making every server test wait on it would only make them slow.
    limiter: options.limiter ?? { take: async () => {} },
    // One window per type, not fourteen. Enough to prove the walk moved and recorded a cursor,
    // which is all any server test asserts; the ordering of a longer walk is run-backfill's
    // own test. A real batch is eighteen types of gzip per trigger and turns this suite into
    // minutes when it runs alongside the others.
    backfillBatchDays: 1,
  })
  await app.ready()

  // What a finished wizard would have left behind, so a test about anything else does not
  // have to walk it.
  const completeSetup = async () => {
    seedPerson(instance.db, 'p1', { displayName: 'Bartus', timezone: 'Europe/Amsterdam' })
    const accounts = new AccountStore(instance.db)
    const settings = new SettingsStore(instance.db)
    await accounts.create({
      id: 'a1', personId: 'p1', username: 'bartus', password: 'a good long password',
      isAdmin: true, nowMs: clock.nowMs,
    })
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: clock.nowMs })
    instance.credentials.putClient({
      clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret', nowMs: clock.nowMs,
    })
    settings.markSetupComplete(clock.nowMs)
  }

  // completeSetup leaves the state between the console step and consent: a client, no token.
  // connectPerson adds the token, which is what a finished wizard actually produces and what
  // anything about syncing needs.
  const connectPerson = async () => {
    await completeSetup()
    instance.credentials.putRefreshToken({
      personId: 'p1', refreshToken: 'stub-refresh-token', scopes: [...SCOPES], nowMs: clock.nowMs,
    })
  }

  return {
    app,
    dir,
    clock,
    completeSetup,
    connectPerson,
    cleanup: async () => {
      await app.close()
      instance.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
