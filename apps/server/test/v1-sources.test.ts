import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { schema, DERIVATION_VERSION } from '@haelan/core'
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

describe('GET /sources, the activity each one reports', () => {
  // The harness clock sits at 2026-02-02 and p1 is in Europe/Amsterdam, so "today" is that date
  // in that zone rather than whatever day the machine running this thinks it is.
  it('calls a source stale once it is silent past its own cadence', async () => {
    seedDates('watch', '2026-01-01', 14)
    const [watch] = (await list()).json().items
    expect(watch).toMatchObject({
      id: 'watch', lastReportedDate: '2026-01-14', reportingDates: 14,
      medianGapDays: 1, status: 'stale', reportingNow: false,
    })
  })

  it('leaves a source that is still reporting alone', async () => {
    seedDates('watch', '2026-01-20', 14)
    const [watch] = (await list()).json().items
    expect(watch).toMatchObject({ id: 'watch', status: 'reporting', reportingNow: true })
  })

  it('answers for a source that has never reported rather than leaving it out', async () => {
    // 'app' is seeded in beforeEach and given no daily rows at all.
    const items = (await list()).json().items
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
    // The activity fields are asserted in their own describe below. They are spelled out here
    // too rather than loosened to toMatchObject, because this is the assertion that catches a
    // field silently appearing or disappearing from the listing's shape.
    const activityOfSourceWithNoRows = {
      lastReportedDate: null, reportingDates: 0, medianGapDays: null,
      status: 'unjudged', reportingNow: false,
    }
    expect(response.json().items).toEqual([
      { id: 'watch', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4', alias: null, name: 'Pixel Watch 4', kind: 'device', createdAtMs: 10, ...activityOfSourceWithNoRows },
      { id: 'app', externalId: 'HEALTH_CONNECT:com.lyfta', displayName: 'com.lyfta', alias: null, name: 'com.lyfta', kind: 'app', createdAtMs: 20, ...activityOfSourceWithNoRows },
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
