import { randomBytes, createHash } from 'node:crypto'
import { eq, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { authSessions } from '../db/schema/index.ts'

export const SESSION_TTL_MS = 30 * 86_400_000

/**
 * How stale lastSeen is allowed to get before resolve() spends a write moving it.
 *
 * Nothing reads lastSeen - not a route, not a query, not a screen - so the only cost of it that
 * matters is the one it imposes on the request that writes it. At zero resolution every
 * authenticated request was a writer, which put the auth path in contention with any long write
 * transaction on the same file. A boot rebuild is exactly that: it rebuilds one person inside a
 * single transaction, so on a household of one it holds the write lock for the whole rebuild, and
 * 1.16.0's DERIVATION_VERSION bump turned that into an instance answering 500 to every
 * authenticated route until it finished. A minute is finer than anything that would ever be shown
 * and coarse enough that a busy instance writes this once a minute per session, not once per
 * request.
 */
export const SESSION_LAST_SEEN_RESOLUTION_MS = 60_000

const digest = (raw: string) => createHash('sha256').update(raw).digest('hex')

export class SessionStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  create(accountId: string, nowMs: number): string {
    const raw = randomBytes(32).toString('base64url')
    this.#db.insert(authSessions).values({
      idHash: digest(raw),
      accountId,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + SESSION_TTL_MS,
      lastSeenAtMs: nowMs,
    }).run()
    return raw
  }

  /**
   * The account this session belongs to, or null.
   *
   * `touch` is how a caller that already knows the database is under a long write transaction
   * declines the lastSeen bookkeeping below. The guard around that write means a refused one
   * costs nothing but time - and time is the point: better-sqlite3's busy handler sleeps the
   * calling thread, so an attempted write under somebody else's lock spends the whole
   * busy_timeout, on Node's only thread, before being swallowed. The server passes false for the
   * length of a boot rebuild (see requireSession in apps/server/src/routes/auth.ts), which is the
   * one window where that is reliably what would happen.
   */
  resolve(rawId: string, nowMs: number, options: { touch?: boolean } = {}): string | null {
    const idHash = digest(rawId)
    const row = this.#db.select().from(authSessions).where(eq(authSessions.idHash, idHash)).get()
    if (!row) return null
    if (row.expiresAtMs <= nowMs) {
      this.#db.delete(authSessions).where(eq(authSessions.idHash, idHash)).run()
      return null
    }
    // lastSeen moves but expiry does not: a session has a fixed life so a compromised cookie
    // cannot be kept alive indefinitely by using it.
    //
    // Only once the window has passed, so the overwhelming majority of authenticated requests
    // resolve a session without writing at all. See SESSION_LAST_SEEN_RESOLUTION_MS for why a
    // column nothing reads is not worth a write per request.
    if (options.touch !== false && nowMs - row.lastSeenAtMs >= SESSION_LAST_SEEN_RESOLUTION_MS) {
      // Swallowed, and deliberately not narrowed to SQLITE_BUSY. The select above has already
      // decided who the caller is; everything after it is bookkeeping on a column nothing reads,
      // so there is no error it can raise that is worth failing an authenticated request over.
      // Narrowing to a code would only mean picking which lock error (BUSY, BUSY_SNAPSHOT,
      // LOCKED) reinstates the outage this guard exists to end.
      //
      // Nor is any signal lost by staying quiet: a database genuinely in trouble - corrupt, full,
      // read only - fails the next write that matters, and those all matter. The sync runner, the
      // rebuild and create() below each throw where somebody is listening. Logging here instead
      // would emit a line per request per session for the length of a rebuild, which is the one
      // moment an operator most needs the log readable.
      try {
        this.#db.update(authSessions).set({ lastSeenAtMs: nowMs }).where(eq(authSessions.idHash, idHash)).run()
      } catch { /* the timestamp, not the session */ }
    }
    return row.accountId
  }

  destroy(rawId: string): void {
    this.#db.delete(authSessions).where(eq(authSessions.idHash, digest(rawId))).run()
  }

  /**
   * Every live session for one account, removed at once. Suspension without this leaves the member
   * signed in until their cookie expires.
   */
  destroyForAccount(accountId: string): number {
    return this.#db.delete(authSessions).where(eq(authSessions.accountId, accountId)).run().changes
  }

  purgeExpired(nowMs: number): number {
    return this.#db.delete(authSessions).where(lte(authSessions.expiresAtMs, nowMs)).run().changes
  }
}
