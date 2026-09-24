import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { RawArchive, closeDatabase, openReadOnly } from '@haelan/core'
import { startCaptureServer } from '../../../demo/capture/server.js'
import { DEMO_CLOCK_MS, DEMO_INSTANT_MS } from '../../../apps/web/src/demo/instant.js'

// Two names because they are two directories, and teardown needs the outer one. The seeder wants
// a `data` child rather than the temp directory itself, so what mkdtempSync returns is the parent
// of what the server is handed; removing only the child left the parent behind on every run, an
// empty haelan-capture-* under %TEMP% that nothing ever collected.
let root: string
let dir: string
let server: Awaited<ReturnType<typeof startCaptureServer>>

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'haelan-capture-'))
  dir = join(root, 'data')
  // Seven days rather than a year: this test is about the bridge, not the data.
  execFileSync('node', ['--experimental-strip-types', 'scripts/seed-demo.mjs', dir, '7'], { stdio: 'pipe' })
  server = await startCaptureServer(dir)
}, 120_000)

afterAll(() => {
  server?.close()
  // Deliberately after close(): SQLite holds a file handle until then, and on Windows rmSync
  // throws EPERM against an open handle - which would replace any assertion error above with a
  // cleanup error and hide it.
  rmSync(root, { recursive: true, force: true })
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

  it('refuses a 200 whose body is not JSON, rather than recording it as if it were', async () => {
    // /export?format=csv is a real route that legitimately answers 200 with a CSV body - the
    // only place in this API's surface that does, which is exactly why it is the right route to
    // prove this refusal against rather than a route built to fail on purpose.
    const url = `/api/v1/p/${server.personId}/export`
      + '?format=csv&metric=steps&agg=sum&from=2026-09-01&to=2026-09-07'
    await expect(server.fetch(url)).rejects.toThrow()
    expect([...server.recorded.keys()].some((key) => key.includes('/export'))).toBe(false)
  })

  // scripts/seed-demo.mjs cuts its last day at the demo's clock (seedArchive's lastDayUntilMs), so
  // the Dashboard is never captured showing data from its own future: before, the seed wrote that
  // day whole and a midday capture said "Good afternoon" over "today until 23:00". Checked against
  // the directory the real seeding path wrote, by each reading's end rather than its start: an
  // hourly step interval that starts at 11:30 and ends at 12:30 is still a reading from the future.
  it('seeded no reading on the last day that ends after the demo clock', () => {
    const finalDayStart = DEMO_INSTANT_MS - 86_400_000
    const db = openReadOnly(dir)
    const ends: Array<{ dataType: string, endMs: number }> = []
    try {
      const archive = new RawArchive(db)
      for (const row of archive.listFor(server.personId)) {
        if (row.windowStartMs !== finalDayStart) continue
        const parsed = JSON.parse(archive.getBody(server.personId, row.id)) as { dataPoints?: unknown[] }
        for (const point of parsed.dataPoints ?? []) {
          const instants = [...JSON.stringify(point).matchAll(/"(?:endTime|physicalTime|time)":"([^"]+)"/g)]
            .map((m) => Date.parse(m[1]!))
          ends.push({ dataType: row.dataType, endMs: Math.max(...instants) })
        }
      }
    } finally {
      closeDatabase(db)
    }
    // Not vacuous: the morning's steps and heart rate are there.
    expect(ends.some((e) => e.dataType === 'steps')).toBe(true)
    expect(ends.some((e) => e.dataType === 'heart-rate')).toBe(true)
    for (const e of ends) expect(e.endMs, e.dataType).toBeLessThanOrEqual(DEMO_CLOCK_MS)
  })

  it('answers the glance as of no later than the demo clock', async () => {
    const response = await server.fetch(`/api/v1/p/${server.personId}/glance`)
    const glance = await response.json() as {
      today: string
      day: { steps: { asOfMs: number | null }, heartRate: { asOfMs: number | null }, stepsPace: { atMs: number } | null }
    }
    expect(glance.today).toBe('2026-09-06')
    expect(glance.day.heartRate.asOfMs).not.toBeNull()
    expect(glance.day.heartRate.asOfMs!).toBeLessThanOrEqual(DEMO_CLOCK_MS)
    expect(glance.day.steps.asOfMs).not.toBeNull()
    expect(glance.day.steps.asOfMs!).toBeLessThanOrEqual(DEMO_CLOCK_MS)
    if (glance.day.stepsPace !== null) expect(glance.day.stepsPace.atMs).toBeLessThanOrEqual(DEMO_CLOCK_MS)
  })
})
