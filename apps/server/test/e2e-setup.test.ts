import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore, SettingsStore, openHaelan, seedPerson } from '@haelan/core'
import { buildServer } from '../src/app.ts'
import { startStubGoogle } from './stub-google.ts'
import type { FastifyInstance } from 'fastify'

const teardown: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of teardown.reverse()) await fn()
  teardown.length = 0
})

const NOW_MS = 1_772_366_400_000

async function listeningServer(options: { webRoot?: string } = {}): Promise<{
  app: FastifyInstance
  base: string
  instance: ReturnType<typeof openHaelan>
  google: Awaited<ReturnType<typeof startStubGoogle>>
}> {
  const google = await startStubGoogle()
  teardown.push(google.close)

  const dir = mkdtempSync(join(tmpdir(), 'haelan-e2e-'))
  const instance = openHaelan(dir, {})
  teardown.push(() => { instance.close(); rmSync(dir, { recursive: true, force: true }) })

  const app = buildServer({
    instance,
    now: () => NOW_MS,
    fetch: globalThis.fetch,
    endpoints: {
      apiRoot: `${google.origin}/v4`,
      tokenEndpoint: `${google.origin}/token`,
      authEndpoint: `${google.origin}/auth`,
    },
    limiter: { take: async () => {} },
    backfillBatchDays: 2,
    // This suite builds the server directly rather than through harness.ts, so without this it
    // runs at the production SPRINT_DAYS (90) against a batch of 2 - 45 passes needed against
    // MAX_SPRINT_PASSES's 40, silently exercising the give-up path instead of the convergence
    // this test means to prove. 4 converges in two passes (ceil(4 / 2) = 2) and says nothing
    // about the production depth, which is asserted in sync-runner.test.ts instead.
    sprintDays: 4,
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
  })
  teardown.push(async () => { await app.haelan.runner.settle(); await app.close() })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
  return { app, base, instance, google }
}

describe('empty volume to syncing instance', () => {
  it('walks the whole route through HTTP and lands rows in tier 2', async () => {
    const { app, base, instance, google } = await listeningServer()
    const headers = { 'content-type': 'application/json', origin: base }

    // 1. Empty volume: the wizard is what the browser gets.
    expect(await (await fetch(`${base}/api/setup/state`)).json()).toEqual({ step: 'account' })

    // 2. First account.
    const created = await fetch(`${base}/api/setup/account`, {
      method: 'POST', headers,
      body: JSON.stringify({
        username: 'bartus', password: 'a good long password',
        displayName: 'Bartus', timezone: 'Europe/Amsterdam',
      }),
    })
    expect(created.status).toBe(201)
    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(cookie).toContain('haelan_session=')
    const authed = { ...headers, cookie }

    // 3. Instance URL.
    const urlStep = await fetch(`${base}/api/setup/instance-url`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({ baseUrl: base, consentPath: 'localhost' }),
    })
    expect(await urlStep.json()).toMatchObject({ redirectUri: `${base}/oauth/callback` })

    // 4. The pasted client.
    const clientStep = await fetch(`${base}/api/setup/google-client`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({ clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret' }),
    })
    expect(clientStep.status).toBe(200)

    // 5. Consent, following the redirect by hand the way a browser would.
    const start = await fetch(`${base}/oauth/start`, { headers: { cookie }, redirect: 'manual' })
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state')
    expect(state).toBeTruthy()
    const callback = await fetch(
      `${base}/oauth/callback?code=good&state=${encodeURIComponent(state!)}`,
      { headers: { cookie }, redirect: 'manual' },
    )
    expect(callback.headers.get('location')).toBe('/setup/backfill')
    expect(await (await fetch(`${base}/api/setup/state`)).json()).toEqual({ step: 'done' })

    // The refresh token is on disk and it is not readable as plaintext.
    const stored = instance.db.$client
      .prepare('select refresh_token_encrypted from credentials').get() as { refresh_token_encrypted: string }
    expect(stored.refresh_token_encrypted).not.toContain('stub-refresh-token')

    // 6. Backfill. The callback starts it, which is what makes the screen it redirects to
    // truthful, so this waits for that run rather than starting one of its own.
    await app.haelan.runner.settle()
    const samples = instance.db.$client.prepare('select count(*) as n from samples').get() as { n: number }
    expect(samples.n).toBeGreaterThan(0)

    // active-minutes and active-zone-minutes carry a sub-dimension the stub has to shape on
    // purpose (see stub-google.ts's subDimensionPoint). A stub point the mapper cannot read
    // would fetch real points and map none of them, which is exactly what recordSchemaDrift
    // exists to flag, silently, without this.
    const drift = instance.db.$client
      .prepare("select data_type, last_error from sync_state where data_type in ('active-minutes', 'active-zone-minutes')")
      .all() as Array<{ data_type: string, last_error: string | null }>
    expect(drift.length).toBe(2)
    expect(drift.every((row) => row.last_error === null), JSON.stringify(drift)).toBe(true)

    expect(google.requests.some((url) => url.includes('/dataPoints'))).toBe(true)
    // Every data plane request carried a bearer token, so nothing went out unauthenticated.
    expect(google.authHeaders.length).toBeGreaterThan(0)
    expect(google.authHeaders.every((header) => header?.startsWith('Bearer '))).toBe(true)

    // 7. Re-running is idempotent: the same windows produce the same row count.
    await app.haelan.runner.trigger('manual')
    const after = instance.db.$client.prepare('select count(*) as n from samples').get() as { n: number }
    expect(after.n).toBe(samples.n)
  }, 60_000)

  it('serves the SPA shell for an unknown path so a refresh mid wizard works', async () => {
    // A directory with a shell in it, rather than a real build: what is under test is the not
    // found handler, and requiring `pnpm build` first would make this suite depend on an
    // artefact that is gitignored and may not exist.
    const webRoot = mkdtempSync(join(tmpdir(), 'haelan-web-'))
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>haelan</title><div id="root"></div>')
    teardown.push(() => rmSync(webRoot, { recursive: true, force: true }))

    const { base, instance } = await listeningServer({ webRoot })

    // A client routed path has no file behind it and must still get the shell, or a reload on
    // /setup/google is a 404 in the middle of the wizard. Asserted before setup finishes,
    // which is the only time the wizard is on screen at all.
    const shell = await fetch(`${base}/setup/google`)
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('id="root"')

    // A real file is still served as itself.
    const index = await fetch(`${base}/index.html`)
    expect(index.status).toBe(200)

    // A file written after the server booted is served. @fastify/static's wildcard:false
    // enumerates the directory once at registration, so a bundle rebuilt underneath a running
    // instance would serve routes for filenames that no longer exist while the new hashed ones
    // fell through to the shell.
    writeFileSync(join(webRoot, 'late.js'), 'export const late = 1')
    const late = await fetch(`${base}/late.js`)
    expect(late.status).toBe(200)
    expect(await late.text()).toContain('export const late')

    // A missing asset is a 404, not the shell. Answering a module script with index.html gives
    // the browser a MIME type error that names neither the file nor the cause, which is what
    // sent a real setup run looking in the wrong place entirely.
    const missingAsset = await fetch(`${base}/assets/index-DoesNotExist.js`)
    expect(missingAsset.status).toBe(404)
    expect(missingAsset.headers.get('content-type')).toContain('application/json')

    const missingFile = await fetch(`${base}/favicon.ico`)
    expect(missingFile.status).toBe(404)

    // With setup finished the gate steps aside, so this reaches the not found handler itself.
    seedPerson(instance.db, 'p1', { displayName: 'Bartus', timezone: 'Europe/Amsterdam' })
    const settings = new SettingsStore(instance.db)
    await new AccountStore(instance.db).create({
      id: 'a1', personId: 'p1', username: 'bartus', password: 'a good long password',
      isAdmin: true, nowMs: NOW_MS,
    })
    settings.put({ baseUrl: base, consentPath: 'localhost', nowMs: NOW_MS })
    instance.credentials.putClient({
      clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret', nowMs: NOW_MS,
    })
    settings.markSetupComplete(NOW_MS)

    // An unknown API route stays JSON: falling through to the shell would hand a fetch caller
    // HTML where it expected an error object.
    const missing = await fetch(`${base}/api/nope`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not_found' })

    // And a client routed path still gets the shell afterwards, so the dashboard survives a
    // reload the same way the wizard did.
    expect((await fetch(`${base}/sleep`)).status).toBe(200)
  }, 30_000)
})
