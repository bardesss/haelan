import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

function seedSource(h: Harness, sourceId: string): void {
  h.app.haelan.instance.db.insert(schema.sources).values({
    id: sourceId, personId: 'p1', externalId: sourceId, displayName: sourceId,
    kind: 'device', createdAtMs: 0,
  }).onConflictDoNothing().run()
}

async function get(h: Harness, token: string, path: string) {
  return h.app.inject({
    method: 'GET', url: `/api/v1/p/p1${path}`, headers: { authorization: `Bearer ${token}` },
  })
}

interface SourceCase {
  name: string
  path: (source: string) => string
}

// Every route on this surface that takes `source`, driven from a table rather than written out
// per route: the defect was one all of them shared, and a route added later that takes a source
// belongs in this list rather than in a hand written case somebody has to remember to add.
const WITH_SOURCE: readonly SourceCase[] = [
  { name: 'series', path: (s) => `/series?metric=steps&agg=sum&from=2026-08-01&to=2026-08-07&source=${s}` },
  { name: 'baselines', path: (s) => `/baselines?metric=steps&agg=sum&on=2026-08-07&source=${s}` },
  { name: 'insights', path: (s) => `/insights?metric=steps&agg=sum&from=2026-08-01&to=2026-08-07&source=${s}` },
  { name: 'trend', path: (s) => `/trend?metric=steps&agg=sum&from=2026-08-01&to=2026-08-07&source=${s}` },
  { name: 'intraday', path: (s) => `/intraday?metric=heart_rate&date=2026-08-22&source=${s}` },
  { name: 'sleep/nights', path: (s) => `/sleep/nights?from=2026-08-01&to=2026-08-07&source=${s}` },
  { name: 'sessions', path: (s) => `/sessions?kind=exercise&from=2026-08-01&to=2026-08-07&source=${s}` },
  { name: 'export', path: (s) => `/export?format=json&metric=steps&agg=sum&from=2026-08-01&to=2026-08-07&source=${s}` },
]

// `source` was the one parameter on this surface that answered a value it could not honour with
// 200 and an empty body. Every other one refuses: a metric, an aggregate, a date, a session kind,
// a format, a points budget. An empty result is indistinguishable from "this person has no data"
// for the range asked for, and in M4 an agent reads that emptiness back as a statement about
// somebody's health record.
describe.each(WITH_SOURCE)('an unknown source is refused rather than answered empty: $name', (route) => {
  // One harness for both cases: neither writes, and the seeding below has to happen once ahead
  // of both requests rather than once per request.
  let harness: Harness
  let token: string

  beforeAll(async () => {
    harness = await withServer()
    token = await harness.signIn()
    seedSource(harness, 'watch')
  })

  afterAll(async () => { await harness.cleanup() })

  it('answers 400 naming the value it could not honour', async () => {
    const response = await get(harness, token, route.path('wtach'))
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { kind: 'config' } })
    expect(response.json().error.message).toContain('wtach')
  })

  // The positive control. A refusal that also refused a real device would be worse than the
  // emptiness it replaced, and no assertion about a 400 can tell the two apart.
  it('still answers 200 for a source this person really has', async () => {
    const response = await get(harness, token, route.path('watch'))
    expect(response.statusCode).toBe(200)
  })
})
