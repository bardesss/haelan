import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { startCaptureServer } from '../../../demo/capture/server.js'

let dir: string
let server: Awaited<ReturnType<typeof startCaptureServer>>

beforeAll(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'haelan-capture-')), 'data')
  // Seven days rather than a year: this test is about the bridge, not the data.
  execFileSync('node', ['--experimental-strip-types', 'scripts/seed-demo.mjs', dir, '7'], { stdio: 'pipe' })
  server = await startCaptureServer(dir)
}, 120_000)

afterAll(() => {
  server?.close()
  // Deliberately after close(): SQLite holds a file handle until then, and on Windows rmSync
  // throws EPERM against an open handle - which would replace any assertion error above with a
  // cleanup error and hide it.
  rmSync(dir, { recursive: true, force: true })
})

describe('the capture server', () => {
  it('answers a real route with real data, through a signed-in session', async () => {
    const response = await server.fetch(`/api/v1/p/${server.personId}/data-types`)
    expect(response.ok).toBe(true)
    const body = await response.json() as { items?: unknown[] }
    expect(Array.isArray(body.items)).toBe(true)
  })

  it('records what it answered, under the canonical url', async () => {
    await server.fetch(`/api/v1/p/${server.personId}/series?to=2026-09-07&from=2026-09-01&agg=sum&metric=steps`)
    expect(server.recorded.has(
      `/api/v1/p/${server.personId}/series?agg=sum&from=2026-09-01&metric=steps&to=2026-09-07`,
    )).toBe(true)
  })

  it('refuses a write, because mounting a page must not change the seeded data', async () => {
    await expect(server.fetch(`/api/v1/p/${server.personId}/overrides`, { method: 'POST', body: '{}' }))
      .rejects.toThrow(/only GET/)
  })

  it('refuses a non-200 rather than recording an error envelope', async () => {
    await expect(server.fetch(`/api/v1/p/${server.personId}/series`)).rejects.toThrow(/400/)
    expect([...server.recorded.keys()].some((url) => url.endsWith('/series'))).toBe(false)
  })
})
