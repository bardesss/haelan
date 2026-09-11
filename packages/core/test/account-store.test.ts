import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { AccountStore } from '../src/store/accounts.ts'
import { ConfigError } from '../src/errors.ts'
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
  id: 'a1', personId: 'p1', username: 'Robin', password: 'correct horse battery staple',
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

  it('lower cases the username, so Robin and robin are one account', async () => {
    await create()
    await expect(store.create({
      id: 'a2', personId: 'p1', username: 'ROBIN', password: 'a good long password', isAdmin: false, nowMs: 2000,
    })).rejects.toThrow(/username/)
  })

  it('accepts the right password', async () => {
    await create()
    const result = await store.login({ username: 'robin', password: 'correct horse battery staple', nowMs: 2000 })
    expect(result).toEqual({
      ok: true,
      account: { id: 'a1', personId: 'p1', username: 'robin', isAdmin: true, disabledAtMs: null },
    })
  })

  it('rejects the wrong password without saying whether the account exists', async () => {
    await create()
    const wrongPassword = await store.login({ username: 'robin', password: 'wrong', nowMs: 2000 })
    const wrongUser = await store.login({ username: 'nobody', password: 'wrong', nowMs: 2000 })
    expect(wrongPassword.ok).toBe(false)
    expect(wrongUser.ok).toBe(false)
    // Both paths run a real verification, so the response time does not answer the question
    // the caller was not allowed to ask.
    expect(wrongUser).toEqual({ ok: false, reason: 'unknown' })
  })

  it('locks an account after ten failures and says so', async () => {
    await create()
    for (let i = 0; i < 10; i++) await store.login({ username: 'robin', password: 'wrong', nowMs: 2000 })
    const locked = await store.login({ username: 'robin', password: 'correct horse battery staple', nowMs: 2000 })
    expect(locked).toEqual({ ok: false, reason: 'locked' })
  })

  it('unlocks once the lock expires', async () => {
    await create()
    for (let i = 0; i < 10; i++) await store.login({ username: 'robin', password: 'wrong', nowMs: 2000 })
    const after = await store.login({
      username: 'robin', password: 'correct horse battery staple', nowMs: 2000 + 15 * 60_000 + 1,
    })
    expect(after.ok).toBe(true)
  })

  it('lists every account in username order, without a hash among the fields', async () => {
    await create()
    seedPerson(fixture.db, 'p2')
    await store.create({
      id: 'a2', personId: 'p2', username: 'alice', password: 'another long password', isAdmin: false, nowMs: 2000,
    })
    const listed = store.list()
    expect(listed).toEqual([
      { id: 'a2', personId: 'p2', username: 'alice', isAdmin: false, disabledAtMs: null, lockedUntilMs: null },
      { id: 'a1', personId: 'p1', username: 'robin', isAdmin: true, disabledAtMs: null, lockedUntilMs: null },
    ])
  })

  it('reports a lock it can see, which is the whole reason list exists', async () => {
    await create()
    for (let i = 0; i < 10; i++) await store.login({ username: 'robin', password: 'wrong', nowMs: 2000 })
    expect(store.list().map((row) => row.lockedUntilMs)).toEqual([2000 + 15 * 60_000])
  })

  it('setPassword replaces the password and leaves admin and disabled alone', async () => {
    await create()
    store.disable('a1', 1500)
    await store.setPassword('robin', 'a brand new password')

    // Disabled, so login answers bad_password whatever is typed. The columns are what can be
    // asserted here, and that the reset did not quietly revive a suspended account is the point.
    const row = fixture.db.$client.prepare('select * from accounts where id = ?').get('a1') as {
      is_admin: number, disabled_at_ms: number | null, password_hash: string
    }
    expect(row.is_admin).toBe(1)
    expect(row.disabled_at_ms).toBe(1500)
    expect(row.password_hash.startsWith('$argon2id$')).toBe(true)

    store.enable('a1')
    const signedIn = await store.login({ username: 'robin', password: 'a brand new password', nowMs: 3000 })
    expect(signedIn.ok).toBe(true)
  })

  it('setPassword accepts the username in any case, the way login does', async () => {
    await create()
    await store.setPassword('  ROBIN  ', 'a brand new password')
    const signedIn = await store.login({ username: 'robin', password: 'a brand new password', nowMs: 3000 })
    expect(signedIn.ok).toBe(true)
  })

  it('setPassword holds the same eight character floor as create', async () => {
    await create()
    await expect(store.setPassword('robin', 'short7!')).rejects.toThrow(/at least 8 characters/)
    const unchanged = await store.login({ username: 'robin', password: 'correct horse battery staple', nowMs: 3000 })
    expect(unchanged.ok).toBe(true)
  })

  // Two accounts, because the failure worth pinning is not the throw. A lookup that fell back to
  // an unfiltered select would resolve a typo to whichever row came first, reset that person's
  // password and report success - and in a household the first account is the admin. Asserting
  // only the rejection would pass against that, since an empty table still throws. So the
  // assertion is that nothing moved.
  it('touches no other account when the username does not exist', async () => {
    await create()
    seedPerson(fixture.db, 'p2')
    await store.create({
      id: 'a2', personId: 'p2', username: 'alice', password: 'another long password', isAdmin: false, nowMs: 2000,
    })
    const hashes = () => fixture.db.$client
      .prepare('select id, password_hash from accounts order by id').all() as Array<{ id: string, password_hash: string }>
    const before = hashes()
    expect(before).toHaveLength(2)

    // The rejection is captured rather than asserted on the spot, so that what did or did not
    // happen to the two accounts is asserted first. Against a lookup that resolved a typo to
    // another row, the informative failure is the changed hash, not the missing throw.
    let reset: unknown = null
    await store.setPassword('nobody', 'a brand new password').catch((err: unknown) => { reset = err })
    expect(hashes()).toEqual(before)
    expect(reset).toBeInstanceOf(ConfigError)
    expect(String(reset)).toContain('no account named nobody')

    for (let i = 0; i < 10; i++) await store.login({ username: 'robin', password: 'wrong', nowMs: 2000 })
    const locked = 2000 + 15 * 60_000
    const lockouts = () => store.list().map((row) => [row.username, row.lockedUntilMs])
    expect(lockouts()).toEqual([['alice', null], ['robin', locked]])

    let cleared: unknown = null
    try { store.clearLockout('nobody') } catch (err) { cleared = err }
    // The lockout the typo did not name is still in force, and neither hash has moved.
    expect(lockouts()).toEqual([['alice', null], ['robin', locked]])
    expect(hashes()).toEqual(before)
    expect(cleared).toBeInstanceOf(ConfigError)
    expect(String(cleared)).toContain('no account named nobody')
  })

  it('clearLockout keeps the hash, so somebody who knows their password is simply let back in', async () => {
    await create()
    const before = fixture.db.$client.prepare('select password_hash from accounts').get() as { password_hash: string }
    for (let i = 0; i < 10; i++) await store.login({ username: 'robin', password: 'wrong', nowMs: 2000 })
    expect(await store.login({ username: 'robin', password: 'correct horse battery staple', nowMs: 2000 }))
      .toEqual({ ok: false, reason: 'locked' })

    store.clearLockout('robin')

    const after = fixture.db.$client.prepare('select password_hash from accounts').get() as { password_hash: string }
    expect(after.password_hash).toBe(before.password_hash)
    const signedIn = await store.login({ username: 'robin', password: 'correct horse battery staple', nowMs: 2000 })
    expect(signedIn.ok).toBe(true)
  })

  it('clears the failure count on a success, so a slow typist is not locked out tomorrow', async () => {
    await create()
    for (let i = 0; i < 9; i++) await store.login({ username: 'robin', password: 'wrong', nowMs: 2000 })
    await store.login({ username: 'robin', password: 'correct horse battery staple', nowMs: 2000 })
    for (let i = 0; i < 9; i++) await store.login({ username: 'robin', password: 'wrong', nowMs: 3000 })
    const stillOpen = await store.login({ username: 'robin', password: 'correct horse battery staple', nowMs: 3000 })
    expect(stillOpen.ok).toBe(true)
  })
})
