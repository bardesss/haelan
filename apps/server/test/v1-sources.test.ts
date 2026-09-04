import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { schema } from '@haelan/core'
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
