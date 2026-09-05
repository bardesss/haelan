import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { invites } from '../db/schema/index.ts'

/**
 * Seven days. Long enough to hand a link over at the weekend, short enough that an unredeemed one
 * sitting in a chat history is not a permanent key to a household member's account. A constant
 * rather than a literal in a route, so the expiry and the copy that states it cannot drift apart.
 */
export const INVITE_TTL_MS = 604_800_000

export interface PendingInvite {
  id: string
  personId: string
  createdAtMs: number
  expiresAtMs: number
}

const digest = (token: string): string => createHash('sha256').update(token).digest('hex')

export class InviteStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  /**
   * The token is returned here and nowhere else, ever again. Generated beside its own hash so no
   * caller can invent one, and 32 bytes because this is the only credential in the system a person
   * receives by being handed it rather than by choosing it.
   */
  create(input: { id: string, personId: string, createdByAccountId: string, nowMs: number }): { invite: PendingInvite, token: string } {
    const token = randomBytes(32).toString('base64url')
    const invite: PendingInvite = {
      id: input.id,
      personId: input.personId,
      createdAtMs: input.nowMs,
      expiresAtMs: input.nowMs + INVITE_TTL_MS,
    }
    this.#db.insert(invites).values({
      ...invite,
      tokenHash: digest(token),
      createdByAccountId: input.createdByAccountId,
      redeemedAtMs: null,
      revokedAtMs: null,
    }).run()
    return { invite, token }
  }

  /**
   * One answer for every way an invite can fail to be usable. Unknown, expired, revoked and
   * already redeemed are the same to the person holding the link, and telling them apart would
   * tell somebody probing which tokens once existed.
   */
  findByToken(token: string, nowMs: number): PendingInvite | null {
    const row = this.#db.select().from(invites).where(and(
      eq(invites.tokenHash, digest(token)),
      isNull(invites.redeemedAtMs),
      isNull(invites.revokedAtMs),
      gt(invites.expiresAtMs, nowMs),
    )).get()
    return row ? toPending(row) : null
  }

  listPending(nowMs: number): PendingInvite[] {
    return this.#db.select().from(invites).where(and(
      isNull(invites.redeemedAtMs),
      isNull(invites.revokedAtMs),
      gt(invites.expiresAtMs, nowMs),
    )).orderBy(asc(invites.createdAtMs)).all().map(toPending)
  }

  // Takes the clock from its caller, the same as every other store: a store that read Date.now()
  // itself could never be driven to a fixed instant in a test.
  revoke(id: string, nowMs: number): void {
    this.#db.update(invites).set({ revokedAtMs: nowMs }).where(eq(invites.id, id)).run()
  }

  markRedeemed(id: string, nowMs: number): void {
    this.#db.update(invites).set({ redeemedAtMs: nowMs }).where(eq(invites.id, id)).run()
  }

  /**
   * Conditional on `redeemed_at_ms` still being null, checked through `changes` rather than a
   * read-then-write: two concurrent redemptions of one token both pass findByToken's check before
   * either writes anything, so whichever call this raced against - a plain UPDATE with no WHERE on
   * the flag - would let both through, and what stopped the second from minting a second account
   * would be accounts.person_id UNIQUE instead, surfacing as a generic 500 rather than the 404
   * every other invalid token gets. This UPDATE can only ever win once: the first caller's write
   * flips the flag inside SQLite's own statement-level lock, so the second caller's identical
   * UPDATE matches zero rows and this returns false for it, before either has created an account.
   */
  claimRedemption(id: string, nowMs: number): boolean {
    const result = this.#db.update(invites).set({ redeemedAtMs: nowMs })
      .where(and(eq(invites.id, id), isNull(invites.redeemedAtMs))).run()
    return result.changes > 0
  }

  /**
   * Undoes a claimRedemption call whose account creation then failed - a taken username, a short
   * password - so the invite is not burned by a redemption the caller never actually completed.
   * Safe to call unconditionally on that failure path: the claim that just succeeded is the only
   * way redeemedAtMs could be non-null for an id this route only ever claims once per request.
   */
  releaseRedemption(id: string): void {
    this.#db.update(invites).set({ redeemedAtMs: null }).where(eq(invites.id, id)).run()
  }
}

function toPending(row: typeof invites.$inferSelect): PendingInvite {
  return {
    id: row.id, personId: row.personId,
    createdAtMs: row.createdAtMs, expiresAtMs: row.expiresAtMs,
  }
}
