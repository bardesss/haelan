import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore, SettingsStore, openHaelan, seedPerson } from '@haelan/core'
import { buildServer } from '../src/app.ts'
import type { FastifyInstance } from 'fastify'

export interface Harness {
  app: FastifyInstance
  dir: string
  clock: { nowMs: number }
  completeSetup: () => Promise<void>
  cleanup: () => Promise<void>
}

export async function withServer(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-server-'))
  const clock = { nowMs: 1_770_000_000_000 }
  const instance = openHaelan(dir, {})
  const app = buildServer({
    instance,
    now: () => clock.nowMs,
    fetch: async () => { throw new Error('no stub fetch installed for this test') },
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
