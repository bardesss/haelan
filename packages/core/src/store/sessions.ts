import { randomBytes, createHash } from 'node:crypto'
import { eq, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { authSessions } from '../db/schema/index.ts'

export const SESSION_TTL_MS = 30 * 86_400_000

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

  resolve(rawId: string, nowMs: number): string | null {
    const idHash = digest(rawId)
    const row = this.#db.select().from(authSessions).where(eq(authSessions.idHash, idHash)).get()
    if (!row) return null
    if (row.expiresAtMs <= nowMs) {
      this.#db.delete(authSessions).where(eq(authSessions.idHash, idHash)).run()
      return null
    }
    // lastSeen moves but expiry does not: a session has a fixed life so a compromised cookie
    // cannot be kept alive indefinitely by using it.
    this.#db.update(authSessions).set({ lastSeenAtMs: nowMs }).where(eq(authSessions.idHash, idHash)).run()
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
