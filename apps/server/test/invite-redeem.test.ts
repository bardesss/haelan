import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness
let bobPersonId: string
let token: string
let revokedToken: string
let redeemedToken: string
let expiredToken: string

const peek = (t: string) => h.app.inject({ method: 'GET', url: `/api/invite/${t}` })

const redeem = (t: string, username: string, password: string) => h.app.inject({
  method: 'POST', url: `/api/invite/${t}`, payload: { username, password },
})

beforeEach(async () => {
  h = await withServer()
  await h.completeSetup()

  const person = h.app.haelan.stores.people.create({
    id: 'p-bob', displayName: 'Bob', timezone: 'Europe/Amsterdam', nowMs: h.clock.nowMs,
  })
  bobPersonId = person.id
  const created = h.app.haelan.instance.invites.create({
    id: 'invite-bob', personId: bobPersonId, createdByAccountId: 'a1', nowMs: h.clock.nowMs,
  })
  token = created.token

  const revoked = h.app.haelan.instance.invites.create({
    id: 'invite-revoked', personId: 'p-bob', createdByAccountId: 'a1', nowMs: h.clock.nowMs,
  })
  revokedToken = revoked.token
  h.app.haelan.instance.invites.revoke('invite-revoked', h.clock.nowMs)

  const redeemed = h.app.haelan.instance.invites.create({
    id: 'invite-redeemed', personId: 'p-bob', createdByAccountId: 'a1', nowMs: h.clock.nowMs,
  })
  redeemedToken = redeemed.token
  h.app.haelan.instance.invites.markRedeemed('invite-redeemed', h.clock.nowMs)

  // Backdated by more than the seven day TTL rather than advancing the shared clock forward:
  // advancing h.clock.nowMs itself would also expire the invites created above, since they share
  // the same clock every later peek() and redeem() call reads.
  const expired = h.app.haelan.instance.invites.create({
    id: 'invite-expired', personId: 'p-bob', createdByAccountId: 'a1', nowMs: h.clock.nowMs - 8 * 86_400_000,
  })
  expiredToken = expired.token
})

afterEach(async () => { await h.cleanup() })

describe('GET /api/invite/:token', () => {
  it('says who the invite is for, without a session', async () => {
    expect((await peek(token)).json()).toEqual({ displayName: 'Bob', timezone: 'Europe/Amsterdam' })
  })

  // One answer for four states: the person holding a bad link learns nothing about which kind of
  // bad it is, and neither does anyone probing.
  it.each([
    ['unknown', () => 'a-token-that-never-existed'],
    ['revoked', () => revokedToken],
    ['redeemed', () => redeemedToken],
    ['expired', () => expiredToken],
  ])('refuses a %s token identically', async (_name, get) => {
    const response = await peek(get())
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: { kind: 'not_found', code: 'no_such_invite', message: 'this invite is no longer valid' },
    })
  })
})

describe('POST /api/invite/:token', () => {
  it('creates the account, signs them in, and never makes them an admin', async () => {
    const response = await redeem(token, 'bob', 'correct horse battery')
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ personId: bobPersonId, username: 'bob' })
    expect(response.headers['set-cookie']).toBeDefined()
    expect(h.app.haelan.stores.accounts.getByPersonId(bobPersonId)?.isAdmin).toBe(false)
  })

  it('cannot be redeemed twice', async () => {
    await redeem(token, 'bob', 'correct horse battery')
    expect((await redeem(token, 'bob2', 'another password')).statusCode).toBe(404)
  })

  it('refuses a username somebody already has', async () => {
    expect((await redeem(token, 'bartus', 'correct horse battery')).statusCode).toBe(400)
  })

  it('refuses a password under eight characters, and leaves the invite usable', async () => {
    expect((await redeem(token, 'bob', 'short')).statusCode).toBe(400)
    expect((await peek(token)).statusCode).toBe(200)
  })
})
