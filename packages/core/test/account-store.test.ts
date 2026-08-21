import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { AccountStore } from '../src/store/accounts.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

let fixture: TestDatabase
let store: AccountStore

beforeEach(() => {
  fixture = createTestDatabase()
  seedPerson(fixture.db, 'p1')
  store = new AccountStore(fixture.db)
})
afterEach(() => fixture.cleanup())

const create = () => store.create({
  id: 'a1', personId: 'p1', username: 'Bartus', password: 'correct horse battery staple',
  isAdmin: true, nowMs: 1000,
})

describe('AccountStore', () => {
  it('counts zero on an empty instance, which is what puts the wizard on screen', () => {
    expect(store.count()).toBe(0)
  })

  it('never stores the password itself', async () => {
    await create()
    const row = fixture.db.$client.prepare('select password_hash from accounts').get() as { password_hash: string }
    expect(row.password_hash).not.toContain('correct horse')
    expect(row.password_hash.startsWith('$argon2id$')).toBe(true)
  })

  it('lower cases the username, so Bartus and bartus are one account', async () => {
    await create()
    await expect(store.create({
      id: 'a2', personId: 'p1', username: 'BARTUS', password: 'a good long password', isAdmin: false, nowMs: 2000,
    })).rejects.toThrow(/username/)
  })

  it('accepts the right password', async () => {
    await create()
    const result = await store.login({ username: 'bartus', password: 'correct horse battery staple', nowMs: 2000 })
    expect(result).toEqual({ ok: true, account: { id: 'a1', personId: 'p1', username: 'bartus', isAdmin: true } })
  })

  it('rejects the wrong password without saying whether the account exists', async () => {
    await create()
    const wrongPassword = await store.login({ username: 'bartus', password: 'wrong', nowMs: 2000 })
    const wrongUser = await store.login({ username: 'nobody', password: 'wrong', nowMs: 2000 })
    expect(wrongPassword.ok).toBe(false)
    expect(wrongUser.ok).toBe(false)
    // Both paths run a real verification, so the response time does not answer the question
    // the caller was not allowed to ask.
    expect(wrongUser).toEqual({ ok: false, reason: 'unknown' })
  })

  it('locks an account after ten failures and says so', async () => {
    await create()
    for (let i = 0; i < 10; i++) await store.login({ username: 'bartus', password: 'wrong', nowMs: 2000 })
    const locked = await store.login({ username: 'bartus', password: 'correct horse battery staple', nowMs: 2000 })
    expect(locked).toEqual({ ok: false, reason: 'locked' })
  })

  it('unlocks once the lock expires', async () => {
    await create()
    for (let i = 0; i < 10; i++) await store.login({ username: 'bartus', password: 'wrong', nowMs: 2000 })
    const after = await store.login({
      username: 'bartus', password: 'correct horse battery staple', nowMs: 2000 + 15 * 60_000 + 1,
    })
    expect(after.ok).toBe(true)
  })

  it('clears the failure count on a success, so a slow typist is not locked out tomorrow', async () => {
    await create()
    for (let i = 0; i < 9; i++) await store.login({ username: 'bartus', password: 'wrong', nowMs: 2000 })
    await store.login({ username: 'bartus', password: 'correct horse battery staple', nowMs: 2000 })
    for (let i = 0; i < 9; i++) await store.login({ username: 'bartus', password: 'wrong', nowMs: 3000 })
    const stillOpen = await store.login({ username: 'bartus', password: 'correct horse battery staple', nowMs: 3000 })
    expect(stillOpen.ok).toBe(true)
  })
})
