import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { mcpTokens } from '../db/schema/index.ts'
import { ConfigError } from '../errors.ts'

/**
 * Every token starts with this. It is not a secret and nothing here parses it: the digest covers
 * the whole string, prefix included. It exists so a value found in a config file, a shell history
 * or a log says what it is - and so the two bearer credentials this app issues are distinguishable
 * by eye, since a session id and an MCP token are otherwise both 32 base64url bytes, and each is
 * refused by the other's guard with the same 401.
 */
export const MCP_TOKEN_PREFIX = 'hmcp_'

/**
 * The three lives a token may be given, in days. Anything else is refused rather than clamped: a
 * caller asking for 3650 days has said something about their intent that silently becoming 365
 * would hide from them.
 */
export const MCP_TOKEN_DAYS = [30, 90, 365] as const
export type McpTokenDays = (typeof MCP_TOKEN_DAYS)[number]
export const DEFAULT_MCP_TOKEN_DAYS: McpTokenDays = 90

export interface McpToken {
  id: string
  accountId: string
  label: string
  createdAtMs: number
  expiresAtMs: number
  lastUsedAtMs: number | null
  revokedAtMs: number | null
}

/**
 * One answer for every way a token can fail to be usable, asked of a row the caller already has.
 * A free function rather than a method so the guard can ask it of a row it holds without a second
 * read, and so a caller cannot forget one of the two conditions by checking only expiry.
 */
export function mcpTokenUsable(token: McpToken, nowMs: number): boolean {
  return token.revokedAtMs === null && token.expiresAtMs > nowMs
}

const digest = (secret: string): string => createHash('sha256').update(secret).digest('hex')

const DAY_MS = 86_400_000

export class McpTokenStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  /**
   * The secret is returned here and nowhere else, ever again. Generated beside its own digest so
   * no caller can invent one, the same arrangement InviteStore.create uses and for the same
   * reason.
   */
  create(input: { id: string, accountId: string, label: string, days: number, nowMs: number }): { token: McpToken, secret: string } {
    const label = input.label.trim()
    if (label === '') {
      throw new ConfigError('a token needs a label, so you can tell later which one to revoke')
    }
    if (!(MCP_TOKEN_DAYS as readonly number[]).includes(input.days)) {
      throw new ConfigError(`a token lasts ${MCP_TOKEN_DAYS.join(', ')} days, not ${input.days}`)
    }
    const secret = MCP_TOKEN_PREFIX + randomBytes(32).toString('base64url')
    const token: McpToken = {
      id: input.id,
      accountId: input.accountId,
      label,
      createdAtMs: input.nowMs,
      expiresAtMs: input.nowMs + input.days * DAY_MS,
      lastUsedAtMs: null,
      revokedAtMs: null,
    }
    this.#db.insert(mcpTokens).values({ ...token, tokenHash: digest(secret) }).run()
    return { token, secret }
  }

  /**
   * Whether this instance has ever minted a token, revoked and expired ones included.
   *
   * What `POST /mcp`'s 404 keys on. Deliberately not "has a usable token": an account that mints
   * one and later revokes it gets a 401 from then on, because going back to a 404 would make a
   * revoked token indistinguishable from a missing route to the one person who is legitimately
   * trying to work out what happened.
   */
  anyExist(): boolean {
    return this.#db.select({ id: mcpTokens.id }).from(mcpTokens).limit(1).all().length > 0
  }

  listForAccount(accountId: string): McpToken[] {
    return this.#db.select().from(mcpTokens)
      .where(eq(mcpTokens.accountId, accountId))
      .orderBy(asc(mcpTokens.createdAtMs)).all().map(toToken)
  }

  /**
   * The row a presented secret hashes to, usable or not.
   *
   * Usability is the caller's question, not this one's, because the guard needs the difference:
   * a secret matching nothing is an anonymous probe and is not logged, while an expired or revoked
   * one is a token somebody still holds and is exactly what the call log exists to show.
   */
  match(secret: string): McpToken | null {
    const row = this.#db.select().from(mcpTokens)
      .where(eq(mcpTokens.tokenHash, digest(secret))).get()
    return row ? toToken(row) : null
  }

  /**
   * Records that the token was accepted as a credential. Expiry does not move: a token has a fixed
   * life so a leaked one cannot be kept alive indefinitely by being used, the same rule
   * SessionStore.resolve applies to a session.
   */
  touch(id: string, nowMs: number): void {
    this.#db.update(mcpTokens).set({ lastUsedAtMs: nowMs }).where(eq(mcpTokens.id, id)).run()
  }

  /**
   * Scoped by account rather than by id alone, so a crafted id in a URL cannot revoke another
   * member's token. Returns false for an id this account does not own, which is the same answer
   * an id that does not exist gets - the route turns both into one 404.
   *
   * isNull(revokedAtMs) as well, so a second revoke of an already revoked token is also a no-op
   * that returns false rather than moving the stamp forward. Without it "revoked on the 3rd" would
   * quietly become "revoked on the 9th" on the row the call log anchors to, for anyone with a
   * session and the id - not reachable from the card, which never shows a Revoke button on a dead
   * token, but reachable directly against the route.
   */
  revoke(input: { id: string, accountId: string, nowMs: number }): boolean {
    return this.#db.update(mcpTokens).set({ revokedAtMs: input.nowMs })
      .where(and(
        eq(mcpTokens.id, input.id),
        eq(mcpTokens.accountId, input.accountId),
        isNull(mcpTokens.revokedAtMs),
      ))
      .run().changes > 0
  }
}

function toToken(row: typeof mcpTokens.$inferSelect): McpToken {
  return {
    id: row.id, accountId: row.accountId, label: row.label,
    createdAtMs: row.createdAtMs, expiresAtMs: row.expiresAtMs,
    lastUsedAtMs: row.lastUsedAtMs, revokedAtMs: row.revokedAtMs,
  }
}
