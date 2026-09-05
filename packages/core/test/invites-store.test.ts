import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { InviteStore, INVITE_TTL_MS } from '../src/store/invites.ts'
import { AccountStore } from '../src/store/accounts.ts'
import { invites } from '../src/db/schema/index.ts'

let test: TestDatabase
let store: InviteStore
const NOW = 1_770_000_000_000
let adminAccountId: string

beforeEach(async () => {
  test = createTestDatabase()
  seedPerson(test.db, 'admin-person')
  seedPerson(test.db, 'p2')
  const account = await new AccountStore(test.db).create({
    id: 'a1', personId: 'admin-person', username: 'admin', password: 'correct horse',
    isAdmin: true, nowMs: NOW,
  })
  adminAccountId = account.id
  store = new InviteStore(test.db)
})
afterEach(() => test.cleanup())

const make = (nowMs = NOW) =>
  store.create({ id: 'i1', personId: 'p2', createdByAccountId: adminAccountId, nowMs })

describe('create', () => {
  it('returns a token and an invite expiring seven days later', () => {
    const { invite, token } = make()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(invite).toEqual({
      id: 'i1', personId: 'p2', createdAtMs: NOW, expiresAtMs: NOW + INVITE_TTL_MS,
    })
  })

  // The same rule auth_sessions follows: a copied database is a list of expiry times, not a set
  // of live credentials. An unredeemed invite creates an account, so it is one.
  it('stores the hash and never the token', () => {
    const { token } = make()
    const row = test.db.select().from(invites).all()[0]!
    expect(row.tokenHash).not.toBe(token)
    expect(JSON.stringify(row)).not.toContain(token)
  })

  it('gives two invites different tokens', () => {
    const first = make().token
    const second = store.create({ id: 'i2', personId: 'p2', createdByAccountId: adminAccountId, nowMs: NOW }).token
    expect(first).not.toBe(second)
  })
})

describe('findByToken', () => {
  it('finds a live invite by its token', () => {
    const { token } = make()
    expect(store.findByToken(token, NOW)).toEqual({
      id: 'i1', personId: 'p2', createdAtMs: NOW, expiresAtMs: NOW + INVITE_TTL_MS,
    })
  })

  it('does not find an unknown token', () => {
    make()
    expect(store.findByToken('not-a-real-token', NOW)).toBeNull()
  })

  it('does not find one past its expiry, and does find one a millisecond before', () => {
    const { token } = make()
    expect(store.findByToken(token, NOW + INVITE_TTL_MS - 1)).not.toBeNull()
    expect(store.findByToken(token, NOW + INVITE_TTL_MS + 1)).toBeNull()
  })

  it('does not find a revoked one', () => {
    const { token } = make()
    store.revoke('i1', NOW)
    expect(store.findByToken(token, NOW)).toBeNull()
  })

  it('does not find a redeemed one', () => {
    const { token } = make()
    store.markRedeemed('i1', NOW + 1)
    expect(store.findByToken(token, NOW)).toBeNull()
  })
})

describe('listPending', () => {
  it('lists only invites that could still be redeemed', () => {
    make()
    store.create({ id: 'i2', personId: 'p2', createdByAccountId: adminAccountId, nowMs: NOW })
    store.create({ id: 'i3', personId: 'p2', createdByAccountId: adminAccountId, nowMs: NOW })
    store.revoke('i2', NOW)
    store.markRedeemed('i3', NOW + 1)
    expect(store.listPending(NOW).map((i) => i.id)).toEqual(['i1'])
  })

  it('omits an expired invite', () => {
    make()
    expect(store.listPending(NOW + INVITE_TTL_MS + 1)).toEqual([])
  })
})
