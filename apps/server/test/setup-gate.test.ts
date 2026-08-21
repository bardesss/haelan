import { describe, it, expect, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

describe('the setup gate', () => {
  it('reports the current step without a session, because nobody can have one yet', async () => {
    harness = await withServer()
    const response = await harness.app.inject({ method: 'GET', url: '/api/setup/state' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ step: 'account' })
  })

  it('refuses every non setup route while setup is unfinished, and names the step that is due', async () => {
    harness = await withServer()
    const response = await harness.app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'setup_incomplete', step: 'account' })
  })

  it('leaves the health check open, so a container probe works during setup', async () => {
    harness = await withServer()
    expect((await harness.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
  })

  it('still reports the step after setup is finished, because the SPA asks on every load', async () => {
    harness = await withServer()
    await harness.completeSetup()
    expect((await harness.app.inject({ method: 'GET', url: '/api/setup/state' })).json()).toEqual({ step: 'done' })
  })
})
