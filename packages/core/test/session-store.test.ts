import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { AccountStore } from '../src/store/accounts.ts'
import { SessionStore, SESSION_TTL_MS } from '../src/store/sessions.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

let fixture: TestDatabase
let sessions: SessionStore

beforeEach(async () => {
  fixture = createTestDatabase()
  seedPerson(fixture.db, 'p1')
  await new AccountStore(fixture.db).create({
    id: 'a1', personId: 'p1', username: 'robin', password: 'a good long password', isAdmin: true, nowMs: 0,
  })
  sessions = new SessionStore(fixture.db)
})
afterEach(() => fixture.cleanup())

describe('SessionStore', () => {
  it('stores the hash of the cookie value and never the value', () => {
    const raw = sessions.create('a1', 1000)
    const stored = fixture.db.$client.prepare('select id_hash from auth_sessions').get() as { id_hash: string }
    expect(stored.id_hash).not.toBe(raw)
    expect(stored.id_hash).toBe(createHash('sha256').update(raw).digest('hex'))
  })

  it('issues a different value every time', () => {
    expect(sessions.create('a1', 1000)).not.toBe(sessions.create('a1', 1000))
  })

  it('resolves a live session to its account', () => {
    const raw = sessions.create('a1', 1000)
    expect(sessions.resolve(raw, 2000)).toBe('a1')
  })

  it('refuses a session past its expiry rather than sliding it forever', () => {
    const raw = sessions.create('a1', 1000)
    expect(sessions.resolve(raw, 1000 + SESSION_TTL_MS + 1)).toBeNull()
  })

  it('refuses a value that was never issued', () => {
    expect(sessions.resolve('not-a-session', 1000)).toBeNull()
  })

  it('makes logout immediate', () => {
    const raw = sessions.create('a1', 1000)
    sessions.destroy(raw)
    expect(sessions.resolve(raw, 1100)).toBeNull()
  })

  it('purges only what has actually expired', () => {
    const stale = sessions.create('a1', 1000)
    const live = sessions.create('a1', 1000 + SESSION_TTL_MS)
    const purged = sessions.purgeExpired(1000 + SESSION_TTL_MS + 1)
    expect(purged).toBe(1)
    expect(sessions.resolve(stale, 1000 + SESSION_TTL_MS + 1)).toBeNull()
    expect(sessions.resolve(live, 1000 + SESSION_TTL_MS + 1)).toBe('a1')
  })
})
