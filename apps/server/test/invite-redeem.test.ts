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

const redeem = (t: string, username: string, password: string, extra: Record<string, unknown> = {}) => h.app.inject({
  method: 'POST', url: `/api/invite/${t}`, payload: { username, password, ...extra },
})

beforeEach(async () => {
  h = await withServer()
  // connectPerson, not completeSetup: master's harness split the two, and these tests were
  // written against a finished instance (the old shortcut carried a token). A client with no
  // token lands back at the connect step under the new setupStep.
  await h.connectPerson()

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

  // Two POSTs on one token, fired together rather than one after the other: both reach
  // findByToken's check while the token is still good, the exact window that used to leave the
  // second one stopped only by accounts.person_id UNIQUE - a generic 500, not the 404 every other
  // invalid token gets. claimRedemption's conditional UPDATE settles which of the two gets to try
  // creating an account before either does, so the loser is refused at the same point, and the
  // same way, as a token that never existed.
  it('redeemed twice at once produces exactly one account, and the loser gets the ordinary 404', async () => {
    const [first, second] = await Promise.all([
      redeem(token, 'bob', 'correct horse battery'),
      redeem(token, 'bob-two', 'another good password'),
    ])
    const results = [first, second]
    const winners = results.filter((r) => r.statusCode === 201)
    const losers = results.filter((r) => r.statusCode !== 201)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]!.statusCode).toBe(404)
    expect(losers[0]!.json()).toEqual({
      error: { kind: 'not_found', code: 'no_such_invite', message: 'this invite is no longer valid' },
    })
    // Exactly one account exists for the person the invite named, under whichever username won -
    // accounts.person_id UNIQUE is a backstop here, not what this test is asking of the route.
    const account = h.app.haelan.stores.accounts.getByPersonId(bobPersonId)
    expect(account?.username).toBe((winners[0]!.json() as { username: string }).username)
  })

  it('refuses a username somebody already has', async () => {
    expect((await redeem(token, 'robin', 'correct horse battery')).statusCode).toBe(400)
  })

  it('refuses a password under eight characters, and leaves the invite usable', async () => {
    expect((await redeem(token, 'bob', 'short')).statusCode).toBe(400)
    expect((await peek(token)).statusCode).toBe(200)
  })

  // T6.1: whoever is invited chooses their own path when redeeming instead of inheriting
  // the admin's. A phone choice is recorded on their person row; anything else leaves it
  // alone for a later consent or a later pairing, and no choice here ever touches the
  // instance flag, which still says only how the wizard once closed.
  it('records a phone choice on the invited person and nobody else', async () => {
    const response = await redeem(token, 'bob', 'correct horse battery', { path: 'companion' })
    expect(response.statusCode).toBe(201)
    expect(h.app.haelan.stores.people.get(bobPersonId)?.companionPath).toBe(true)
    expect(h.app.haelan.stores.people.get('p1')?.companionPath).toBe(false)
    expect(h.app.haelan.stores.settings.get()?.companionMode).toBe(false)
  })

  it('redeeming without a choice leaves the phone path off', async () => {
    expect((await redeem(token, 'bob', 'correct horse battery')).statusCode).toBe(201)
    expect(h.app.haelan.stores.people.get(bobPersonId)?.companionPath).toBe(false)
  })

  it('redeeming with an explicit google choice leaves the phone path off', async () => {
    expect((await redeem(token, 'bob', 'correct horse battery', { path: 'google' })).statusCode).toBe(201)
    expect(h.app.haelan.stores.people.get(bobPersonId)?.companionPath).toBe(false)
  })

  it('refuses an unknown path, and leaves the invite usable', async () => {
    const response = await redeem(token, 'bob', 'correct horse battery', { path: 'carrier-pigeon' })
    expect(response.statusCode).toBe(400)
    expect((await peek(token)).statusCode).toBe(200)
  })
})
