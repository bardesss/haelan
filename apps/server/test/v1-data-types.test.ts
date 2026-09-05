import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DATA_TYPES } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness
let token: string

beforeEach(async () => {
  h = await withServer()
  token = await h.signIn()
})
afterEach(() => h.cleanup())

// A function, not a const: `token` is assigned in beforeEach, so a module-level object would
// capture undefined and every request would 401.
const auth = () => ({ authorization: `Bearer ${token}` })

const list = () => h.app.inject({ method: 'GET', url: '/api/v1/p/p1/data-types', headers: auth() })

const listWithEtag = (etag: string) => h.app.inject({
  method: 'GET', url: '/api/v1/p/p1/data-types', headers: { ...auth(), 'if-none-match': etag },
})

const putRaw = (body: Record<string, unknown>) => h.app.inject({
  method: 'PUT', url: '/api/v1/p/p1/data-types',
  headers: { ...auth(), 'content-type': 'application/json' },
  payload: body,
})

const put = (excluded: string[]) => putRaw({ excluded })

describe('GET /data-types', () => {
  it('lists every catalogue type the sync engine can fetch, none excluded to begin with', async () => {
    // Same predicate as SyncStateStore.dueJobs (packages/core/src/store/syncState.ts), not
    // `supports(t, 'list')`: this screen offers exactly what the sync engine could otherwise
    // fetch, which includes `floors` and `total-calories` even though neither takes a `list`
    // action (both are fetched through rollUp/dailyRollUp/reconcile instead).
    const items = (await list()).json().items
    expect(items.map((i: { id: string }) => i.id))
      .toEqual(DATA_TYPES.filter((t) => t.actions.length > 0).map((t) => t.id))
    expect(items.every((i: { excluded: boolean }) => i.excluded === false)).toBe(true)
  })

  it('marks what the person excluded', async () => {
    await put(['hydration-log'])
    const items = (await list()).json().items
    expect(items.find((i: { id: string }) => i.id === 'hydration-log').excluded).toBe(true)
    expect(items.find((i: { id: string }) => i.id === 'steps').excluded).toBe(false)
  })

  it('lists a type with no `list` action, and it can be excluded through PUT', async () => {
    // The finding this test is here to catch: `floors` has actions (rollUp, dailyRollUp,
    // reconcile) but none of them is `list`, so a GET filtered on `supports(t, 'list')` would
    // never show it - a permanent blind spot, since no screen built from this endpoint could
    // ever offer a control to turn it off. dueJobs's own predicate does not have that gap.
    const before = (await list()).json().items
    expect(before.find((i: { id: string }) => i.id === 'floors')).toEqual({
      id: 'floors', tier: 'daily', excluded: false,
    })

    await put(['floors'])
    const after = (await list()).json().items
    expect(after.find((i: { id: string }) => i.id === 'floors')).toEqual({
      id: 'floors', tier: 'daily', excluded: true,
    })
  })

  it('answers 304 for a repeated ETag', async () => {
    const etag = (await list()).headers.etag as string
    expect((await listWithEtag(etag)).statusCode).toBe(304)
  })
})

describe('PUT /data-types', () => {
  it('replaces the set and answers what it stored', async () => {
    await put(['floors', 'hydration-log'])
    expect((await put(['floors'])).json()).toEqual({ excluded: ['floors'] })
  })

  it('accepts an empty list, meaning everything is on', async () => {
    await put(['floors'])
    expect((await put([])).json()).toEqual({ excluded: [] })
  })

  it('refuses an id the catalogue does not declare', async () => {
    const response = await put(['not-a-data-type'])
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  it('refuses a body that is not a list of strings', async () => {
    expect((await putRaw({ excluded: 'floors' })).statusCode).toBe(400)
  })

  // The isolation rule this surface is built on.
  it('cannot be written for another person', async () => {
    const other = await h.addPerson({ id: 'p2', displayName: 'Other', username: 'other' })
    const response = await h.app.inject({
      method: 'PUT', url: `/api/v1/p/${other.personId}/data-types`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { excluded: ['floors'] },
    })
    expect(response.statusCode).toBe(403)
  })
})
