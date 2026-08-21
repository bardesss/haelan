import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHaelan } from '@haelan/core'
import { buildServer } from '../src/app.ts'
import type { FastifyInstance } from 'fastify'

export interface Harness {
  app: FastifyInstance
  dir: string
  clock: { nowMs: number }
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
  return {
    app,
    dir,
    clock,
    cleanup: async () => {
      await app.close()
      instance.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
