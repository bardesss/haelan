import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore, PeopleStore, SCOPES, SettingsStore, openHaelan } from '@haelan/core'
import { buildServer } from '../src/app.ts'
import type { FastifyInstance } from 'fastify'

const NOW_MS = 1_770_000_000_000
const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }

const teardown: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of teardown.reverse()) await fn()
  teardown.length = 0
})

// The restore procedure README documents, played out as a real operator hits it: a data
// directory whose credential rows were sealed under one instance.key, opened by an instance
// that no longer has it. Nothing here stubs the failure - the ciphertext on disk is genuinely
// the ciphertext putClient wrote, and the key the second instance holds is genuinely a
// different 32 bytes, because openHaelan wrote itself a fresh one on a key-less boot.
async function restoredWithoutTheKey(): Promise<{
  app: FastifyInstance, dir: string, originalKey: string,
}> {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-restore-'))
  teardown.push(() => rmSync(dir, { recursive: true, force: true }))

  const sealed = openHaelan(dir, {})
  new PeopleStore(sealed.db).create({
    id: 'p1', displayName: 'Robin', timezone: 'Europe/Amsterdam', nowMs: NOW_MS,
  })
  await new AccountStore(sealed.db).create({
    id: 'a1', personId: 'p1', username: 'robin', password: 'a good long password',
    isAdmin: true, nowMs: NOW_MS,
  })
  new SettingsStore(sealed.db).put({
    baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: NOW_MS,
  })
  sealed.credentials.putClient({
    clientId: 'id.apps.googleusercontent.com', clientSecret: 'the console secret', nowMs: NOW_MS,
  })
  sealed.credentials.putRefreshToken({
    personId: 'p1', refreshToken: 'the original refresh token', scopes: [...SCOPES], nowMs: NOW_MS,
  })
  new SettingsStore(sealed.db).markSetupComplete(NOW_MS)
  const originalKey = sealed.key.toString('base64')
  sealed.close()

  // The backup carries the database and not the key, so this is what landing one on a machine
  // that never had the original looks like on disk.
  unlinkSync(join(dir, 'instance.key'))

  const instance = openHaelan(dir, {})
  teardown.push(() => instance.close())
  const app = buildServer({
    instance,
    now: () => NOW_MS,
    fetch: async () => { throw new Error('nothing here should reach Google') },
    limiter: { take: async () => {} },
    dataDir: dir,
    backupKeep: 7,
    backupIntervalHours: 24,
    backfillBatchDays: 1,
    sprintDays: 2,
  })
  teardown.push(async () => { await app.haelan.runner.settle(); await app.close() })
  await app.ready()
  return { app, dir, originalKey }
}

describe('a database restored without its instance.key', () => {
  it('answers, and puts the operator back on the Google client step', async () => {
    const { app } = await restoredWithoutTheKey()

    // The route the container's own HEALTHCHECK probes, and the one the setup gate's preHandler
    // computes for every other request. Before this fix getClient threw out of setupStep here,
    // which made this 500 and took every /api/* and /oauth/* route with it.
    const state = await app.inject({ method: 'GET', url: '/api/setup/state' })
    expect(state.statusCode).toBe(200)
    expect(state.json()).toEqual({ step: 'google-client' })

    // What the browser asks first. 409 is the wizard's cue; a 500 was nothing's cue. The step
    // itself was already asserted above through /api/setup/state, the endpoint whose entire job
    // is answering that question - not a substring pulled out of this message.
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(me.statusCode).toBe(409)
    expect(me.json()).toEqual({
      error: { kind: 'setup_incomplete', code: 'setup_incomplete', message: expect.any(String) },
    })

    // The operator's session. The account step is long past, so signing in is the only way to
    // hold one, and the wizard's remaining steps all require it.
    const signedIn = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: ORIGIN,
      payload: { username: 'robin', password: 'a good long password' },
    })
    expect(signedIn.statusCode).toBe(200)
    const cookie = signedIn.cookies.find((c) => c.name === 'haelan_session')?.value ?? ''
    expect(cookie).not.toBe('')
    const authed = { ...ORIGIN, cookie: `haelan_session=${cookie}` }

    // Re-entering what the operator still has in their Google console. This is the whole repair:
    // the secret is not recoverable, but it is not lost either.
    const reentered = await app.inject({
      method: 'POST', url: '/api/setup/google-client', headers: authed,
      payload: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'the console secret' },
    })
    expect(reentered.statusCode).toBe(200)
    expect(reentered.json()).toEqual({ step: 'done' })

    // And consent is reachable again, which is the second half of what README promises.
    const start = await app.inject({ method: 'GET', url: '/oauth/start', headers: authed })
    expect(start.statusCode).toBe(302)
    expect(start.headers.location).toContain('id.apps.googleusercontent.com')

    // The person is not connected and was not disconnected: their row is still exactly what
    // putRefreshToken wrote, and the app names the state rather than presenting them as
    // connected and silently failing to sync.
    const session = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authed })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({ connected: false, credentialsUnreadable: true })
  })

  it('deletes nothing, so the original key still opens every token', async () => {
    const { app, dir, originalKey } = await restoredWithoutTheKey()

    const signedIn = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: ORIGIN,
      payload: { username: 'robin', password: 'a good long password' },
    })
    const cookie = signedIn.cookies.find((c) => c.name === 'haelan_session')?.value ?? ''
    await app.inject({
      method: 'POST', url: '/api/setup/google-client',
      headers: { ...ORIGIN, cookie: `haelan_session=${cookie}` },
      payload: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'the console secret' },
    })

    // Walking away from the whole repair and coming back with the key that turns up in a drawer
    // a week later. The refresh token has to be the one that was sealed a restore ago, or
    // README's "nothing is deleted" is a promise about a row this branch quietly rewrote.
    await app.haelan.runner.settle()
    await app.close()
    // Reading the row through a store holding the original key rather than the one the key-less
    // boot generated for itself, which is what putting the found file back over it amounts to.
    const found = openHaelan(dir, { HAELAN_ENCRYPTION_KEY: originalKey })
    try {
      expect(found.credentials.getRefreshToken('p1')?.refreshToken).toBe('the original refresh token')
      expect(found.credentials.isCredentialsUnreadable('p1')).toBe(false)
    } finally {
      found.close()
    }
  })
})
