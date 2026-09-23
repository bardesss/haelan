import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  ConfigError, McpCallLog, McpTokenStore, MCP_CALL_LOG_TTL_MS, MCP_TOKEN_PREFIX,
  createTestDatabase, mcpTokenUsable, schema, seedPerson,
} from '../src/index.ts'
import type { TestDatabase } from '../src/index.ts'

const NOW = 1_770_000_000_000
const DAY = 86_400_000

let test: TestDatabase
let tokens: McpTokenStore
let calls: McpCallLog

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'alice')
  test.db.insert(schema.accounts).values({
    id: 'acct-alice', personId: 'alice', username: 'alice',
    passwordHash: 'x', isAdmin: false, failedAttempts: 0, lockedUntilMs: null,
    createdAtMs: NOW, disabledAtMs: null,
  }).run()
  tokens = new McpTokenStore(test.db)
  calls = new McpCallLog(test.db)
})
afterEach(() => test.cleanup())

const mint = (over: Partial<{ id: string, label: string, days: number }> = {}) => tokens.create({
  id: over.id ?? 't1', accountId: 'acct-alice', label: over.label ?? 'laptop',
  days: over.days ?? 90, nowMs: NOW,
})

describe('McpTokenStore', () => {
  it('answers no tokens on a fresh instance, which is what the 404 at POST /mcp keys on', () => {
    expect(tokens.anyExist()).toBe(false)
    mint()
    expect(tokens.anyExist()).toBe(true)
  })

  it('returns the secret once and stores only its digest', () => {
    const { secret, token } = mint()
    expect(secret.startsWith(MCP_TOKEN_PREFIX)).toBe(true)
    expect(token.expiresAtMs).toBe(NOW + 90 * DAY)

    const row = test.db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.id, 't1')).get()!
    // Every column, not just the hash: a secret copied into a label or an id would pass a check
    // that only looked at token_hash.
    expect(JSON.stringify(row)).not.toContain(secret)
    expect(row.tokenHash).toHaveLength(64)
  })

  it('matches a presented secret and refuses one that was never issued', () => {
    const { secret } = mint()
    expect(tokens.match(secret)?.id).toBe('t1')
    expect(tokens.match(`${MCP_TOKEN_PREFIX}not-a-real-token`)).toBeNull()
  })

  it('refuses a token with no label, because an unnamed token is one nobody revokes', () => {
    expect(() => mint({ label: '   ' })).toThrow(ConfigError)
  })

  it('refuses a life that is not one of the three offered', () => {
    expect(() => mint({ days: 7 })).toThrow(ConfigError)
  })

  it('calls an expired token unusable without deleting it', () => {
    const { token } = mint({ days: 30 })
    expect(mcpTokenUsable(token, NOW + 29 * DAY)).toBe(true)
    expect(mcpTokenUsable(token, NOW + 31 * DAY)).toBe(false)
  })

  it('revokes as a stamp, scoped to the owning account', () => {
    mint()
    expect(tokens.revoke({ id: 't1', accountId: 'someone-else', nowMs: NOW + 1 })).toBe(false)
    expect(tokens.revoke({ id: 't1', accountId: 'acct-alice', nowMs: NOW + 1 })).toBe(true)

    const [row] = tokens.listForAccount('acct-alice')
    expect(row?.revokedAtMs).toBe(NOW + 1)
    expect(mcpTokenUsable(row!, NOW + 2)).toBe(false)
  })

  it('a second revoke is a no-op, so the stamp cannot be pushed forward', () => {
    mint()
    expect(tokens.revoke({ id: 't1', accountId: 'acct-alice', nowMs: NOW + 1 })).toBe(true)
    expect(tokens.revoke({ id: 't1', accountId: 'acct-alice', nowMs: NOW + 999 })).toBe(false)

    const [row] = tokens.listForAccount('acct-alice')
    expect(row?.revokedAtMs).toBe(NOW + 1)
  })

  // Why a token stopped working is what its owner wants to know, and a password change revoking
  // it on their behalf used to leave nothing but a date behind: a member whose agent went dark
  // had no way to tell that a reset last week was the cause.
  it('records why a token was revoked, and a live token has no reason', () => {
    mint({ id: 't1' })
    mint({ id: 't2' })
    expect(tokens.listForAccount('acct-alice').map((t) => t.revokedReason)).toEqual([null, null])

    tokens.revoke({ id: 't1', accountId: 'acct-alice', nowMs: NOW + 1 })
    expect(tokens.revokeAllForAccount('acct-alice', NOW + 2, 'password_reset')).toBe(1)

    // By id: both were minted at NOW, so their order under listForAccount's createdAtMs sort is a tie.
    const byId = (id: string) => tokens.listForAccount('acct-alice').find((t) => t.id === id)
    const [first, second] = [byId('t1'), byId('t2')]
    // The earlier, more specific fact survives: t1 was already revoked by hand, and the reset
    // neither restamps it nor rewrites why.
    expect(first).toMatchObject({ id: 't1', revokedAtMs: NOW + 1, revokedReason: 'manual' })
    expect(second).toMatchObject({ id: 't2', revokedAtMs: NOW + 2, revokedReason: 'password_reset' })
  })

  it('moves lastUsedAtMs on touch and leaves expiry alone', () => {
    const { token } = mint()
    tokens.touch('t1', NOW + 5)
    const [row] = tokens.listForAccount('acct-alice')
    expect(row?.lastUsedAtMs).toBe(NOW + 5)
    expect(row?.expiresAtMs).toBe(token.expiresAtMs)
  })
})

describe('McpCallLog', () => {
  const record = (over: Partial<{ id: string, atMs: number, tool: string | null }> = {}) => calls.record({
    id: over.id ?? 'c1', tokenId: 't1', atMs: over.atMs ?? NOW,
    tool: over.tool === undefined ? 'query_series' : over.tool,
    rowCount: 12, durationMs: 3, outcome: 'ok',
  })

  it('lists the caller own calls newest first, through the token that made them', () => {
    mint()
    record({ id: 'c1', atMs: NOW })
    record({ id: 'c2', atMs: NOW + 1000 })
    expect(calls.listForAccount('acct-alice', 10).map((c) => c.id)).toEqual(['c2', 'c1'])
    expect(calls.listForAccount('acct-nobody', 10)).toEqual([])
  })

  it('records a refusal, which has a token but no tool', () => {
    mint()
    calls.record({
      id: 'c9', tokenId: 't1', atMs: NOW, tool: null,
      rowCount: null, durationMs: null, outcome: 'refused',
    })
    const [row] = calls.listForAccount('acct-alice', 10)
    expect(row).toEqual({
      id: 'c9', tokenId: 't1', atMs: NOW, tool: null,
      rowCount: null, durationMs: null, outcome: 'refused',
    })
  })

  it('prunes past the horizon and leaves the rest', () => {
    mint()
    record({ id: 'old', atMs: NOW })
    record({ id: 'new', atMs: NOW + MCP_CALL_LOG_TTL_MS })
    expect(calls.prune(NOW + MCP_CALL_LOG_TTL_MS + 1)).toBe(1)
    expect(calls.listForAccount('acct-alice', 10).map((c) => c.id)).toEqual(['new'])
  })
})
