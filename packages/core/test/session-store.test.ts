import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { AccountStore } from '../src/store/accounts.ts'
import { SessionStore, SESSION_TTL_MS, SESSION_LAST_SEEN_RESOLUTION_MS } from '../src/store/sessions.ts'
import { openDatabase, closeDatabase } from '../src/db/open.ts'
import type { Database } from '../src/db/open.ts'
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

  // lastSeen has no reader anywhere in the codebase - no route, no query, no screen - so its
  // value is only ever worth what it costs to keep. Writing it on every authenticated request
  // made every read of a session a writer, which is what put the auth path in contention with the
  // boot rebuild the describe below stands in for.
  it('leaves lastSeen alone for a request that arrives within the resolution window', () => {
    const raw = sessions.create('a1', 1000)
    sessions.resolve(raw, 1000 + SESSION_LAST_SEEN_RESOLUTION_MS - 1)
    const stored = fixture.db.$client.prepare('select last_seen_at_ms from auth_sessions').get() as { last_seen_at_ms: number }
    expect(stored.last_seen_at_ms).toBe(1000)
  })

  // The other half of the same decision, so coarsening cannot quietly become "never write": past
  // the window the timestamp does move, and it moves to now rather than to the window's edge.
  it('moves lastSeen once the window has passed', () => {
    const raw = sessions.create('a1', 1000)
    sessions.resolve(raw, 1000 + SESSION_LAST_SEEN_RESOLUTION_MS)
    const stored = fixture.db.$client.prepare('select last_seen_at_ms from auth_sessions').get() as { last_seen_at_ms: number }
    expect(stored.last_seen_at_ms).toBe(1000 + SESSION_LAST_SEEN_RESOLUTION_MS)
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

/**
 * A boot rebuild runs in its own process (apps/server/src/rebuildInWorker.ts) and rebuilds one
 * person inside a single transaction, so on a household of one it holds SQLite's write lock for
 * the whole rebuild - measured at up to fifteen minutes on real data. Every authenticated request
 * goes through resolve(), so a resolve() that cannot survive that lock is an instance that answers
 * nothing at all until the rebuild commits. That is what 1.16.0's DERIVATION_VERSION bump shipped:
 * resolve()'s lastSeen write waited out busy_timeout, threw SQLITE_BUSY, and became a 500 on every
 * authenticated route.
 *
 * The lock is taken from a second connection to the same file rather than from a second process,
 * because SQLite does not care which it is and a process would cost the test a spawn.
 */
describe('SessionStore while a rebuild holds the write lock', () => {
  let other: Database | null = null

  // Called from the test body rather than a beforeEach, and always after the seeding writes have
  // committed: create() is itself a write, so a lock taken any earlier would block the setup
  // rather than the call under test.
  const holdWriteLock = () => {
    other = openDatabase(fixture.dir)
    // IMMEDIATE, not DEFERRED: a deferred transaction takes no write lock until its first write,
    // and what this stands in for is a rebuild already partway through writing.
    other.$client.exec('begin immediate')
  }

  // Guarded on the handle rather than wrapped in try/catch: a rollback that threw here would
  // replace the assertion error with its own and hide which behaviour actually broke.
  afterEach(() => {
    if (other === null) return
    other.$client.exec('rollback')
    closeDatabase(other)
    other = null
  })

  it('resolves a live session rather than failing the request', () => {
    const raw = sessions.create('a1', 1000)
    holdWriteLock()
    expect(sessions.resolve(raw, 2000)).toBe('a1')
  })

  // The case coarsening alone cannot carry: past the window resolve() does want to write, and
  // every rebuild outlasts the window. A timestamp nothing reads must not be able to fail the
  // request that happened to be the one to move it.
  // What the server actually does with the flag it already keeps. Surviving the lock is not the
  // whole of it: better-sqlite3's busy handler sleeps the calling thread, so an attempted write
  // under the lock costs the full busy_timeout - five seconds of Node's only thread, per session,
  // per window, for the length of the rebuild. The caller that knows a rebuild is running can say
  // so and skip a write it already knows will be refused.
  it('skips the write entirely when the caller says not to touch', () => {
    const raw = sessions.create('a1', 1000)
    holdWriteLock()

    const started = performance.now()
    expect(sessions.resolve(raw, 1000 + SESSION_LAST_SEEN_RESOLUTION_MS, { touch: false })).toBe('a1')
    const elapsed = performance.now() - started

    // The assertion has to be about the clock, because the returned account id is the same either
    // way: the guard above already turns a refused write into a resolved session. What `touch`
    // buys is not attempting it, and the only visible difference between attempting and not is
    // the five seconds better-sqlite3 spends asleep in its busy handler first. Measured at 6.1s
    // without this option and single-digit milliseconds with it, so the bound below sits an order
    // of magnitude clear of the real figure on either side - wide enough for a loaded Windows
    // runner, far too tight for a busy_timeout to hide in.
    expect(elapsed).toBeLessThan(1000)
  })

  it('resolves a live session when lastSeen is stale enough to want a write', () => {
    const raw = sessions.create('a1', 1000)
    // This connection's own busy timeout, lowered from the 5s open.ts sets so the test does not
    // sit out a wait it is not asserting on. What is under test is that a locked database costs
    // the timestamp rather than the session, which holds at any timeout.
    fixture.db.$client.pragma('busy_timeout = 50')
    holdWriteLock()
    expect(sessions.resolve(raw, 1000 + SESSION_LAST_SEEN_RESOLUTION_MS)).toBe('a1')
  })
})
