import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { schema, DERIVATION_VERSION, DEFAULT_LIST } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness
let token: string

beforeEach(async () => {
  h = await withServer()
  await h.completeSetup()
  token = await h.signIn()
  h.app.haelan.instance.db.insert(schema.sources).values([
    { id: 'watch', personId: 'p1', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4', kind: 'device', createdAtMs: 10 },
    { id: 'app', personId: 'p1', externalId: 'HEALTH_CONNECT:com.lyfta', displayName: 'com.lyfta', kind: 'app', createdAtMs: 20 },
  ]).run()
})
afterEach(() => h.cleanup())

// A function, not a const: `token` is assigned in beforeEach, so a module-level object would
// capture undefined and every request would 401.
const auth = () => ({ authorization: `Bearer ${token}` })

const list = () => h.app.inject({ method: 'GET', url: '/api/v1/p/p1/sources', headers: auth() })

/** The same listing with the activity fields, which the settings card asks for and nothing else does. */
const listWithActivity = () => h.app.inject({
  method: 'GET', url: '/api/v1/p/p1/sources?activity=1', headers: auth(),
})

const rename = (sourceId: string, alias: string) => h.app.inject({
  method: 'PUT',
  url: `/api/v1/p/p1/sources/${sourceId}/alias`,
  headers: { ...auth(), 'content-type': 'application/json' },
  payload: { alias },
})

/** Reporting dates for a source, so the activity fields have something to be computed from. */
const seedDates = (sourceId: string, from: string, days: number) => {
  const start = Date.parse(`${from}T00:00:00Z`)
  for (let i = 0; i < days; i += 1) {
    h.app.haelan.instance.db.insert(schema.daily).values({
      personId: 'p1', localDate: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      metric: 'steps', agg: 'sum', source: sourceId, value: 1000, coverage: 0.9,
      sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
  }
}

describe('GET /sources, the cost of the activity fields', () => {
  // useSourceNames backs ControlRow and IntradayHeartRate as well as the settings card, so this
  // route is hit by every page. Computing staleness measured 19-60ms against a real archive and
  // grows with the daily row count, so it is opt in: only the one caller that shows it asks.
  it('leaves the activity fields out unless they are asked for', async () => {
    seedDates('watch', '2026-01-01', 14)
    const [watch] = (await list()).json().items
    expect(watch).not.toHaveProperty('status')
    expect(watch).not.toHaveProperty('lastReportedDate')
    expect(watch).toMatchObject({ id: 'watch', name: 'Pixel Watch 4' })
  })
})

describe('GET /sources, the activity each one reports', () => {
  // The harness clock sits at 2026-02-02 and p1 is in Europe/Amsterdam, so "today" is that date
  // in that zone rather than whatever day the machine running this thinks it is.
  it('calls a source stale once it is silent past its own cadence', async () => {
    seedDates('watch', '2026-01-01', 14)
    const [watch] = (await listWithActivity()).json().items
    expect(watch).toMatchObject({
      id: 'watch', lastReportedDate: '2026-01-14', reportingDates: 14,
      medianGapDays: 1, status: 'stale', reportingNow: false,
    })
  })

  it('says whether a stale source carried on under another id, which is what the cards read', async () => {
    // The app takes over the watch's one metric the day after it stops, as a renamed device's
    // new id does. The listing still calls the old id stale; the cards read the second field.
    seedDates('watch', '2026-01-01', 14)
    seedDates('app', '2026-01-15', 19)
    const items = (await listWithActivity()).json().items
    const watch = items.find((i: { id: string }) => i.id === 'watch')
    expect(watch).toMatchObject({ status: 'stale', continuedElsewhere: true })
    const app = items.find((i: { id: string }) => i.id === 'app')
    expect(app).toMatchObject({ status: 'reporting', continuedElsewhere: false })
  })

  it('leaves a source that is still reporting alone', async () => {
    seedDates('watch', '2026-01-20', 14)
    const [watch] = (await listWithActivity()).json().items
    expect(watch).toMatchObject({ id: 'watch', status: 'reporting', reportingNow: true })
  })

  it('answers for a source that has never reported rather than leaving it out', async () => {
    // 'app' is seeded in beforeEach and given no daily rows at all.
    const items = (await listWithActivity()).json().items
    const app = items.find((i: { id: string }) => i.id === 'app')
    expect(app).toMatchObject({
      lastReportedDate: null, reportingDates: 0, medianGapDays: null,
      status: 'unjudged', reportingNow: false,
    })
  })
})

describe('GET /sources', () => {
  it('lists the person\'s sources with the provider name until one is set', async () => {
    const response = await list()
    expect(response.statusCode).toBe(200)
    expect(response.json().items).toEqual([
      { id: 'watch', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4', alias: null, name: 'Pixel Watch 4', kind: 'device', createdAtMs: 10 },
      { id: 'app', externalId: 'HEALTH_CONNECT:com.lyfta', displayName: 'com.lyfta', alias: null, name: 'com.lyfta', kind: 'app', createdAtMs: 20 },
    ])
  })

  it('answers 304 for a repeated ETag', async () => {
    const first = await list()
    const etag = first.headers.etag as string
    const second = await h.app.inject({
      method: 'GET', url: '/api/v1/p/p1/sources',
      headers: { ...auth(), 'if-none-match': etag },
    })
    expect(second.statusCode).toBe(304)
  })

  it('needs a session', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/v1/p/p1/sources' })
    expect(response.statusCode).toBe(401)
  })
})

describe('PUT /sources/:sourceId/alias', () => {
  it('sets the name and the list shows it', async () => {
    const response = await rename('watch', '  My watch  ')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ name: 'My watch' })
    expect((await list()).json().items[0]).toMatchObject({ alias: 'My watch', name: 'My watch' })
  })

  it('refuses an empty name', async () => {
    const response = await rename('watch', '   ')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  it('refuses a name longer than 64 characters', async () => {
    expect((await rename('watch', 'x'.repeat(65))).statusCode).toBe(400)
    expect((await rename('watch', 'x'.repeat(64))).statusCode).toBe(200)
  })

  it('refuses a name already used for another of this person\'s sources', async () => {
    await rename('watch', 'Watch')
    const response = await rename('app', 'Watch')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  it('answers not_found for a source that does not exist', async () => {
    const response = await rename('nope', 'Anything')
    expect(response.statusCode).toBe(404)
    expect(response.json().error.kind).toBe('not_found')
  })

  // The isolation rule: another person's source is indistinguishable from one that is not there,
  // so nobody can probe for the existence of somebody else's rows.
  it('answers not_found for another person\'s source', async () => {
    const other = await h.addPerson({ id: 'p2', displayName: 'Other', username: 'other' })
    h.app.haelan.instance.db.insert(schema.sources).values({
      id: 'theirs', personId: other.personId, externalId: 'x', displayName: 'Theirs', kind: 'device', createdAtMs: 0,
    }).run()
    const response = await rename('theirs', 'Mine now')
    expect(response.statusCode).toBe(404)
    expect((await list()).json().items.map((s: { id: string }) => s.id)).toEqual(['watch', 'app'])
  })
})

describe('GET /source-priority', () => {
  const priority = () => h.app.inject({ method: 'GET', url: '/api/v1/p/p1/source-priority', headers: auth() })

  it('answers the fallback order when nothing is configured', async () => {
    const response = await priority()
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.configured).toBe(false)
    // 'watch' is a device and 'app' is an app, which is fallbackOrder's own kind ordering; the
    // two are what beforeEach seeds, and neither has a stored ranking yet.
    expect(body.order.map((e: { sourceId: string }) => e.sourceId)).toEqual(['watch', 'app'])
    expect(body.order.every((e: { configured: boolean }) => e.configured === false)).toBe(true)
  })

  it('answers the stored order once configured', async () => {
    h.app.haelan.instance.sourcePriority.put({
      personId: 'p1', metric: DEFAULT_LIST, sourceIds: ['app', 'watch'], nowMs: 1,
    })
    const response = await priority()
    const body = response.json()
    expect(body.configured).toBe(true)
    expect(body.order.map((e: { sourceId: string }) => e.sourceId)).toEqual(['app', 'watch'])
    expect(body.order.every((e: { configured: boolean }) => e.configured === true)).toBe(true)
  })

  it('needs a session', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/v1/p/p1/source-priority' })
    expect(response.statusCode).toBe(401)
  })
})

describe('PUT /source-priority', () => {
  const put = (sourceIds: string[]) => h.app.inject({
    method: 'PUT',
    url: '/api/v1/p/p1/source-priority',
    headers: { ...auth(), 'content-type': 'application/json' },
    payload: { sourceIds },
  })

  it('refuses a list that omits one of the person\'s sources', async () => {
    // priorityFrom treats a list as a complete statement, so an omitted source falls to
    // UNRANKED_BASE and loses to every ranked one on historical days. Refusing is what keeps a
    // screen from silently demoting a retired watch.
    const response = await put(['watch'])
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  it('stores a complete list and answers the new order', async () => {
    const response = await put(['app', 'watch'])
    expect(response.statusCode).toBe(200)
    expect(response.json().order.map((e: { sourceId: string }) => e.sourceId)).toEqual(['app', 'watch'])
    expect(response.json().order.every((e: { configured: boolean }) => e.configured === true)).toBe(true)
    expect(response.json().configured).toBe(true)
  })

  it('clears the list when given an empty array', async () => {
    h.app.haelan.instance.sourcePriority.put({
      personId: 'p1', metric: DEFAULT_LIST, sourceIds: ['app', 'watch'], nowMs: 1,
    })
    const response = await put([])
    expect(response.statusCode).toBe(200)
    expect(response.json().configured).toBe(false)
    // Cleared, not emptied: the fallback order still answers both of this person's sources.
    expect(response.json().order.map((e: { sourceId: string }) => e.sourceId)).toEqual(['watch', 'app'])
  })

  it('refuses another person\'s source', async () => {
    const other = await h.addPerson({ id: 'p2', displayName: 'Other', username: 'other' })
    h.app.haelan.instance.db.insert(schema.sources).values({
      id: 'their-watch', personId: other.personId, externalId: 'x', displayName: 'Theirs', kind: 'device', createdAtMs: 0,
    }).run()
    const response = await put(['watch', 'app', 'their-watch'])
    expect(response.statusCode).toBe(400)
  })

  it('refuses a body whose sourceIds is not an array', async () => {
    const response = await h.app.inject({
      method: 'PUT', url: '/api/v1/p/p1/source-priority',
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: { sourceIds: 'watch' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  it('refuses a list naming the same source twice', async () => {
    const response = await put(['watch', 'app', 'watch'])
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  it('needs a session', async () => {
    const response = await h.app.inject({
      method: 'PUT', url: '/api/v1/p/p1/source-priority', payload: { sourceIds: [] },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('DELETE /sources/:sourceId/alias', () => {
  it('removes the name and falls back to the provider\'s', async () => {
    await rename('watch', 'My watch')
    const response = await h.app.inject({
      method: 'DELETE', url: '/api/v1/p/p1/sources/watch/alias', headers: auth(),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ name: 'Pixel Watch 4' })
  })

  it('is not an error when no name was set', async () => {
    const response = await h.app.inject({
      method: 'DELETE', url: '/api/v1/p/p1/sources/watch/alias', headers: auth(),
    })
    expect(response.statusCode).toBe(200)
  })
})
