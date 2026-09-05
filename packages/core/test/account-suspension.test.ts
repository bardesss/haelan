import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { AccountStore } from '../src/store/accounts.ts'
import { SessionStore } from '../src/store/sessions.ts'

let test: TestDatabase
let accounts: AccountStore
let sessions: SessionStore
const NOW = 1_770_000_000_000
const PASSWORD = 'correct horse battery'

beforeEach(async () => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  seedPerson(test.db, 'p2')
  accounts = new AccountStore(test.db)
  sessions = new SessionStore(test.db)
  await accounts.create({ id: 'a1', personId: 'p1', username: 'ann', password: PASSWORD, isAdmin: true, nowMs: NOW })
  await accounts.create({ id: 'a2', personId: 'p2', username: 'bob', password: PASSWORD, isAdmin: false, nowMs: NOW })
})
afterEach(() => test.cleanup())

describe('disable', () => {
  it('refuses the right password with exactly the answer a wrong one gets', async () => {
    const wrong = await accounts.login({ username: 'bob', password: 'not the password', nowMs: NOW })
    accounts.disable('a2', NOW)
    const disabled = await accounts.login({ username: 'bob', password: PASSWORD, nowMs: NOW })
    // Whole-value comparison on purpose: a disabled account that answered a different reason would
    // tell anyone trying a username that it exists.
    expect(disabled).toEqual(wrong)
  })

  it('leaves other accounts able to sign in', async () => {
    accounts.disable('a2', NOW)
    const result = await accounts.login({ username: 'ann', password: PASSWORD, nowMs: NOW })
    expect(result.ok).toBe(true)
  })

  it('reports the timestamp so an admin can see when', () => {
    accounts.disable('a2', NOW)
    expect(accounts.getById('a2')?.disabledAtMs).toBe(NOW)
  })
})

describe('enable', () => {
  it('lets them back in', async () => {
    accounts.disable('a2', NOW)
    accounts.enable('a2')
    const result = await accounts.login({ username: 'bob', password: PASSWORD, nowMs: NOW })
    expect(result.ok).toBe(true)
    expect(accounts.getById('a2')?.disabledAtMs).toBeNull()
  })
})

describe('destroyForAccount', () => {
  // Without this a suspended member stays signed in until their cookie expires, which is exactly
  // the window a suspension is meant to close.
  it('removes that account\'s sessions and nobody else\'s', () => {
    const theirs = sessions.create('a2', NOW)
    const mine = sessions.create('a1', NOW)
    expect(sessions.destroyForAccount('a2')).toBe(1)
    // SessionStore's real lookup method is `resolve`, not `verify` - the brief's sketch used a
    // name this store does not expose, so the check is rewritten against the actual API while
    // keeping the same meaning: the target account's session is gone, the other account's is not.
    expect(sessions.resolve(theirs, NOW)).toBeNull()
    expect(sessions.resolve(mine, NOW)).not.toBeNull()
  })
})
