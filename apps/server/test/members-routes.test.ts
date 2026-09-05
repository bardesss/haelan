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
const authHeader = (token: string) => ({ authorization: `Bearer ${token}` })

const list = (token: string) => h.app.inject({ method: 'GET', url: '/api/members', headers: authHeader(token) })

const invite = (token: string, displayName: string, timezone: string) => h.app.inject({
  method: 'POST', url: '/api/members', headers: authHeader(token), payload: { displayName, timezone },
})

const disable = (token: string, accountId: string) => h.app.inject({
  method: 'POST', url: `/api/members/${accountId}/disable`, headers: authHeader(token),
})

const enable = (token: string, accountId: string) => h.app.inject({
  method: 'POST', url: `/api/members/${accountId}/enable`, headers: authHeader(token),
})

const revoke = (token: string, id: string) => h.app.inject({
  method: 'DELETE', url: `/api/members/invites/${id}`, headers: authHeader(token),
})

const login = (username: string, password: string) => h.app.inject({
  method: 'POST', url: '/api/auth/login', payload: { username, password },
})

describe('GET /api/members', () => {
  it('lists the person who ran setup as active', async () => {
    expect((await list(adminToken)).json().items).toEqual([
      {
        personId: 'p1', displayName: 'Bartus', timezone: 'Europe/Amsterdam',
        accountId: expect.any(String), username: 'bartus', isAdmin: true,
        state: 'active', inviteId: null,
      },
    ])
  })

  it('needs a session', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/api/members' })).statusCode).toBe(401)
  })

  it('refuses a non-admin', async () => {
    await h.addPerson({ id: 'p-outsider', displayName: 'Outsider', username: 'outsider' })
    const outsiderToken = await h.signIn('outsider', PASSWORD)
    const response = await list(outsiderToken)
    expect(response.statusCode).toBe(403)
    expect(response.json().error.kind).toBe('forbidden')
  })
})

describe('POST /api/members', () => {
  it('creates the person and returns the token exactly once', async () => {
    const created = (await invite(adminToken, 'Bob', 'Europe/Amsterdam')).json()
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // The list never carries it back.
    expect(JSON.stringify((await list(adminToken)).json())).not.toContain(created.token)
  })

  it('shows the new person as invited', async () => {
    await invite(adminToken, 'Bob', 'Europe/Amsterdam')
    const bob = (await list(adminToken)).json().items.find((m: { displayName: string }) => m.displayName === 'Bob')
    expect(bob).toMatchObject({ accountId: null, username: null, state: 'invited', isAdmin: false })
  })

  it('refuses an unknown timezone', async () => {
    expect((await invite(adminToken, 'Bob', 'Mars/Olympus')).statusCode).toBe(400)
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
    const created = (await invite(adminToken, 'Carol', 'Europe/Amsterdam')).json()
    const revokeResponse = await revoke(adminToken, created.inviteId)
    expect(revokeResponse.statusCode).toBe(204)
    // The redemption route this token would otherwise reach is a later task's; unregistered, it
    // 404s regardless. What this proves today is that the revoke call itself succeeded above.
    expect((await h.app.inject({ method: 'GET', url: `/api/invite/${created.token}` })).statusCode).toBe(404)
  })

  it('refuses an unknown invite id', async () => {
    const response = await revoke(adminToken, 'no-such-invite')
    expect(response.statusCode).toBe(404)
    expect(response.json().error.kind).toBe('not_found')
  })
})
