import { describe, it, expect, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

describe('the server', () => {
  it('answers a health check without touching the database', async () => {
    harness = await withServer()
    const response = await harness.app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it('runs migrations at boot, so a fresh volume already has the schema', async () => {
    harness = await withServer()
    const response = await harness.app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    // openHaelan migrated on construction. A boot that skipped it would leave people missing.
    const row = harness.app.haelan.instance.db.$client
      .prepare("select name from sqlite_master where type = 'table' and name = 'people'").get()
    expect(row).toBeDefined()
  })
})
