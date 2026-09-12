import { desc, eq, lt } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { mcpCalls, mcpTokens } from '../db/schema/index.ts'
import type { McpCallOutcome } from '../db/schema/index.ts'

/**
 * Ninety days. Long enough that "was this token being used before I noticed" has an answer, short
 * enough that the log is not a permanent record of when a member was awake. Pruned on the
 * maintenance tick beside the backup prune, so one place decides what is old.
 */
export const MCP_CALL_LOG_TTL_MS = 90 * 86_400_000

export interface McpCall {
  id: string
  tokenId: string
  atMs: number
  tool: string | null
  rowCount: number | null
  durationMs: number | null
  outcome: McpCallOutcome
}

export class McpCallLog {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  record(call: McpCall): void {
    this.#db.insert(mcpCalls).values(call).run()
  }

  /**
   * The caller's own calls, newest first, reached through the token that made them rather than
   * through a duplicated account column. A revocation is a stamp rather than a delete precisely so
   * this join never dangles.
   */
  listForAccount(accountId: string, limit: number): McpCall[] {
    return this.#db.select({
      id: mcpCalls.id, tokenId: mcpCalls.tokenId, atMs: mcpCalls.atMs, tool: mcpCalls.tool,
      rowCount: mcpCalls.rowCount, durationMs: mcpCalls.durationMs, outcome: mcpCalls.outcome,
    }).from(mcpCalls)
      .innerJoin(mcpTokens, eq(mcpCalls.tokenId, mcpTokens.id))
      .where(eq(mcpTokens.accountId, accountId))
      .orderBy(desc(mcpCalls.atMs)).limit(limit).all()
  }

  prune(nowMs: number, ttlMs: number = MCP_CALL_LOG_TTL_MS): number {
    return this.#db.delete(mcpCalls).where(lt(mcpCalls.atMs, nowMs - ttlMs)).run().changes
  }
}
