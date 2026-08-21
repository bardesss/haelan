import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore, SCOPES, SettingsStore, openHaelan, seedPerson } from '@haelan/core'
import { buildServer } from '../src/app.ts'
import type { FastifyInstance } from 'fastify'

export type GoogleMode = 'ok' | 'redirect_uri_mismatch' | 'service_disabled'

export interface WithServerOptions { google?: GoogleMode }

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
    throw new Error(`the stub was asked for ${url}, which it does not serve`)
  }) as unknown as typeof globalThis.fetch
}

export interface Harness {
  app: FastifyInstance
  dir: string
  clock: { nowMs: number }
  completeSetup: () => Promise<void>
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

  return {
    app,
    dir,
    clock,
    completeSetup,
    cleanup: async () => {
      await app.close()
      instance.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
