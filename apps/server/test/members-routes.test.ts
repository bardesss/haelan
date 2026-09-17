import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

const PASSWORD = 'a good long password'

let h: Harness
let adminToken: string

beforeEach(async () => {
  h = await withServer()
  await h.completeSetup()
  adminToken = await h.signIn()
})
afterEach(async () => { await h.cleanup() })

// A function, not a const object: the token named varies per caller across these tests (admin,
// bob, an outsider), unlike v1-sources.test.ts's single fixed session.
// null stands for no session at all: every case below that wants the 401 path calls its request
// with no token rather than a bad one, the same distinction v1-isolation.test.ts draws between
// "no session" and "a session that owns something else".
const authHeader = (token: string | null) => (token === null ? {} : { authorization: `Bearer ${token}` })

const list = (token: string | null) => h.app.inject({ method: 'GET', url: '/api/members', headers: authHeader(token) })

// No timezone: the invite body carries one field now, and the person's zone comes from the
// inviting admin's own row. profile-routes.test.ts is where that inheritance is asserted.
const invite = (token: string | null, displayName: string) => h.app.inject({
  method: 'POST', url: '/api/members', headers: authHeader(token), payload: { displayName },
})

const disable = (token: string | null, accountId: string) => h.app.inject({
  method: 'POST', url: `/api/members/${accountId}/disable`, headers: authHeader(token),
})

const enable = (token: string | null, accountId: string) => h.app.inject({
  method: 'POST', url: `/api/members/${accountId}/enable`, headers: authHeader(token),
})

const resetPassword = (token: string | null, accountId: string) => h.app.inject({
  method: 'POST', url: `/api/members/${accountId}/password`, headers: authHeader(token),
  payload: { password: 'a replacement password' },
})

const revoke = (token: string | null, id: string) => h.app.inject({
  method: 'DELETE', url: `/api/members/invites/${id}`, headers: authHeader(token),
})

const login = (username: string, password: string) => h.app.inject({
  method: 'POST', url: '/api/auth/login', payload: { username, password },
})

describe('GET /api/members', () => {
  it('lists the person who ran setup as active', async () => {
    expect((await list(adminToken)).json().items).toEqual([
      {
        personId: 'p1', displayName: 'Robin', timezone: 'Europe/Amsterdam',
        accountId: expect.any(String), username: 'robin', isAdmin: true,
        state: 'active', inviteId: null,
        // Signed in, because the token this suite holds came from a real login; nothing synced
        // yet, so the floor across everything this person syncs is "never".
        lastLoginAtMs: expect.any(Number),
        sync: { oldestSuccessAtMs: null, neverSucceeded: expect.any(Number), failing: 0, due: expect.any(Number) },
      },
    ])
  })

  // An invited row has no account to have signed in, and nothing of its own to sync: both figures
  // are absent rather than filled in with a zero or a "never" that would read as a fault.
  it('leaves both figures off a row that has no account yet', async () => {
    await invite(adminToken, 'Bob')
    const bob = (await list(adminToken)).json().items
      .find((m: { displayName: string }) => m.displayName === 'Bob')
    expect(bob).toMatchObject({ state: 'invited', lastLoginAtMs: null, sync: null })
  })

  // The stamp only a real sign-in writes. An account created through the store has never signed
  // in, and says so, until it does.
  it('reports when an account last signed in, and null until it has', async () => {
    await h.addPerson({ id: 'p-bob', displayName: 'Bob', username: 'bob' })
    const findBob = async () => (await list(adminToken)).json().items
      .find((m: { displayName: string }) => m.displayName === 'Bob')
    expect(await findBob()).toMatchObject({ lastLoginAtMs: null })

    await login('bob', PASSWORD)

    expect(await findBob()).toMatchObject({ lastLoginAtMs: expect.any(Number) })
  })

  // The floor, which is the whole point of the aggregate: one type synced now cannot make a
  // household look fresh while the rest of it has never run.
  it('reports the oldest success across the types a person syncs, not the newest', async () => {
    const stores = h.app.haelan.stores
    for (const type of ['steps', 'weight']) {
      stores.syncState.recordSuccess({ personId: 'p1', dataType: type, highWaterMs: 1, nowMs: 500 })
    }
    const item = (await list(adminToken)).json().items[0]
    // Every other type has still never run, so the floor is null however fresh these two are.
    expect(item.sync.oldestSuccessAtMs).toBeNull()
    expect(item.sync.neverSucceeded).toBeGreaterThan(0)
  })
})

// Spec section 7 asks this of every route this file registers, not just GET: unauthorized with no
// session, forbidden for a signed in non-admin. Before this table, only GET carried both cases -
// the whole authorization claim rested on one shared `guard` array literal in members.ts and
// nothing here would have failed if a future edit dropped it from one of the other four.
describe('every route requires a session and an admin', () => {
  let outsiderToken: string

  beforeEach(async () => {
    await h.addPerson({ id: 'p-outsider', displayName: 'Outsider', username: 'outsider' })
    outsiderToken = await h.signIn('outsider', PASSWORD)
  })

  const cases: { name: string, send: (token: string | null) => ReturnType<typeof list> }[] = [
    { name: 'GET /api/members', send: (token) => list(token) },
    { name: 'POST /api/members', send: (token) => invite(token, 'Someone') },
    // Both ids are made up: the guard runs as a preHandler, ahead of any lookup the handler itself
    // does, so a request that never gets past the guard cannot tell an unknown id from a real one.
    { name: 'POST /api/members/:accountId/disable', send: (token) => disable(token, 'a-nonexistent') },
    { name: 'POST /api/members/:accountId/enable', send: (token) => enable(token, 'a-nonexistent') },
    { name: 'POST /api/members/:accountId/password', send: (token) => resetPassword(token, 'a-nonexistent') },
    { name: 'DELETE /api/members/invites/:id', send: (token) => revoke(token, 'invite-nonexistent') },
  ]

  it.each(cases)('$name answers unauthorized with no session', async ({ send }) => {
    const response = await send(null)
    expect(response.statusCode).toBe(401)
    expect(response.json().error.kind).toBe('unauthorized')
  })

  it.each(cases)('$name answers forbidden for a non-admin session', async ({ send }) => {
    const response = await send(outsiderToken)
    expect(response.statusCode).toBe(403)
    expect(response.json().error.kind).toBe('forbidden')
  })
})

describe('POST /api/members', () => {
  it('creates the person and returns the token exactly once', async () => {
    const created = (await invite(adminToken, 'Bob')).json()
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // The list never carries it back.
    expect(JSON.stringify((await list(adminToken)).json())).not.toContain(created.token)
  })

  it('shows the new person as invited', async () => {
    await invite(adminToken, 'Bob')
    const bob = (await list(adminToken)).json().items.find((m: { displayName: string }) => m.displayName === 'Bob')
    expect(bob).toMatchObject({ accountId: null, username: null, state: 'invited', isAdmin: false })
  })

  // The timezone the invited person lands in, and the fact that the body no longer carries one,
  // are profile-routes.test.ts's subject. What used to be here was a test that an unknown
  // timezone was refused; there is no longer a field to send one in.

  it('refuses an empty or whitespace-only displayName', async () => {
    const empty = await invite(adminToken, '')
    expect(empty.statusCode).toBe(400)
    expect(empty.json().error.kind).toBe('config')

    const blank = await invite(adminToken, '   ')
    expect(blank.statusCode).toBe(400)
    expect(blank.json().error.kind).toBe('config')
  })
})

describe('disable and enable', () => {
  let bobAccountId: string
  let bobToken: string

  beforeEach(async () => {
    // Redeem an invite (task 4 builds redemption); here, create the account through the store
    // directly, the way the brief for this task says to.
    const bob = await h.addPerson({ id: 'p-bob', displayName: 'Bob', username: 'bob' })
    bobAccountId = bob.accountId
    bobToken = await h.signIn('bob', PASSWORD)
  })

  it('signs the disabled member out immediately', async () => {
    const beforeDisable = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeader(bobToken) })
    expect(beforeDisable.statusCode).toBe(200)

    const disableResponse = await disable(adminToken, bobAccountId)
    expect(disableResponse.statusCode).toBe(200)
    expect(disableResponse.json()).toEqual({ state: 'disabled' })

    const afterDisable = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeader(bobToken) })
    expect(afterDisable.statusCode).toBe(401)
  })

  it('refuses to disable the caller\'s own account', async () => {
    const response = await disable(adminToken, 'a1')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  it('lets a disabled member back in after enable', async () => {
    await disable(adminToken, bobAccountId)
    const enableResponse = await enable(adminToken, bobAccountId)
    expect(enableResponse.statusCode).toBe(200)
    expect(enableResponse.json()).toEqual({ state: 'active' })
    expect((await login('bob', PASSWORD)).statusCode).toBe(200)
  })
})

describe('DELETE /api/members/invites/:id', () => {
  it('revokes an unredeemed invite so its token stops working', async () => {
    const created = (await invite(adminToken, 'Carol')).json()
    const revokeResponse = await revoke(adminToken, created.inviteId)
    expect(revokeResponse.statusCode).toBe(204)

    // The redemption route this token would otherwise reach is a later task's, so the token
    // itself can't be checked here. What proves revoke() actually ran, rather than the handler
    // just answering 204, is that the row now reads as an expired invite rather than the still
    // pending one: no account and no pending invite is exactly what the 'expired' state means.
    const carol = (await list(adminToken)).json().items.find((m: { personId: string }) => m.personId === created.personId)
    expect(carol).toEqual({
      personId: created.personId, displayName: 'Carol', timezone: 'Europe/Amsterdam',
      accountId: null, username: null, isAdmin: false, state: 'expired', inviteId: null,
      // Both activity figures absent, like every row with no account behind it.
      lastLoginAtMs: null, sync: null,
    })

    // A second revoke of the same id finds nothing pending to revoke.
    expect((await revoke(adminToken, created.inviteId)).statusCode).toBe(404)
  })

  it('refuses an unknown invite id', async () => {
    const response = await revoke(adminToken, 'no-such-invite')
    expect(response.statusCode).toBe(404)
    expect(response.json().error.kind).toBe('not_found')
  })
})
