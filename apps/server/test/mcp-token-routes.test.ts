import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MCP_TOKEN_PREFIX } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness
let session: string

beforeEach(async () => {
  h = await withServer()
  await h.completeSetup()
  session = await h.signIn()
})
afterEach(async () => { await h.cleanup() })

const auth = (token: string) => ({ authorization: `Bearer ${token}` })
const list = (token: string) => h.app.inject({ method: 'GET', url: '/api/profile/mcp-tokens', headers: auth(token) })
const mint = (token: string, body: Record<string, unknown>) =>
  h.app.inject({ method: 'POST', url: '/api/profile/mcp-tokens', headers: auth(token), payload: body })
const revoke = (token: string, id: string) =>
  h.app.inject({ method: 'DELETE', url: `/api/profile/mcp-tokens/${id}`, headers: auth(token) })
const calls = (token: string) => h.app.inject({ method: 'GET', url: '/api/profile/mcp-calls', headers: auth(token) })

// Whether an MCP secret still opens POST /mcp, exercising the guard the same way an agent would
// rather than reading mcp_tokens back off the store - the property Important 5 cares about is
// that the credential itself stops working, not merely that a column changed.
const usable = async (secret: string): Promise<boolean> => {
  const response = await h.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_metrics', arguments: {} } },
  })
  return response.statusCode === 200
}

describe('the Profile card routes', () => {
  it('mints a token, returns the secret once, and never returns it again', async () => {
    const created = await mint(session, { label: 'the laptop', days: 30 })
    expect(created.statusCode).toBe(201)
    const { secret, token } = created.json() as { secret: string, token: { id: string, label: string, expiresAtMs: number } }
    expect(secret.startsWith(MCP_TOKEN_PREFIX)).toBe(true)
    expect(token.label).toBe('the laptop')
    expect(token.expiresAtMs).toBe(h.clock.nowMs + 30 * 86_400_000)

    const listed = await list(session)
    expect(listed.statusCode).toBe(200)
    // The whole body, because a secret leaking through a field nobody expected is exactly the
    // failure this assertion is for.
    expect(listed.body).not.toContain(secret)
    expect((listed.json() as { tokens: unknown[] }).tokens).toHaveLength(1)
  })

  it('defaults to ninety days when none is asked for', async () => {
    const created = await mint(session, { label: 'no days given' })
    expect((created.json() as { token: { expiresAtMs: number } }).token.expiresAtMs)
      .toBe(h.clock.nowMs + 90 * 86_400_000)
  })

  it('refuses a life that is not one of the three offered, and an empty label', async () => {
    expect((await mint(session, { label: 'x', days: 7 })).statusCode).toBe(400)
    expect((await mint(session, { label: '   ' })).statusCode).toBe(400)
    expect((await mint(session, {})).statusCode).toBe(400)
  })

  it('revokes the caller own token and refuses another member one', async () => {
    const wilma = await h.addPerson({ id: 'p2', displayName: 'Wilma', username: 'wilma' })
    const hers = h.mintMcpToken({ accountId: wilma.accountId })
    const mine = (await mint(session, { label: 'mine' })).json() as { token: { id: string } }

    // Another member's token is not found rather than forbidden: the caller has no business
    // knowing the id exists at all.
    expect((await revoke(session, hers.id)).statusCode).toBe(404)
    expect((await revoke(session, mine.token.id)).statusCode).toBe(204)

    // Revocation is a stamp: the row stays so the call log still names something.
    const rows = (await list(session)).json().tokens as { id: string, revokedAtMs: number | null }[]
    expect(rows).toEqual([expect.objectContaining({
      id: mine.token.id, revokedAtMs: h.clock.nowMs, revokedReason: 'manual',
    })])
  })

  it('reports the caller own recent calls and nobody else', async () => {
    const wilma = await h.addPerson({ id: 'p2', displayName: 'Wilma', username: 'wilma' })
    const hers = h.mintMcpToken({ accountId: wilma.accountId })
    h.app.haelan.stores.mcpCalls.record({
      id: 'hers', tokenId: hers.id, atMs: h.clock.nowMs, tool: 'list_metrics',
      rowCount: 4, durationMs: 1, outcome: 'ok',
    })
    const mine = h.mintMcpToken({ label: 'mine' })
    h.app.haelan.stores.mcpCalls.record({
      id: 'mine', tokenId: mine.id, atMs: h.clock.nowMs, tool: 'get_sleep',
      rowCount: 2, durationMs: 1, outcome: 'ok',
    })

    const body = (await calls(session)).json() as { calls: { id: string }[] }
    expect(body.calls.map((c) => c.id)).toEqual(['mine'])
  })

  it('turns an anonymous caller away from all four', async () => {
    for (const response of [
      await h.app.inject({ method: 'GET', url: '/api/profile/mcp-tokens' }),
      await h.app.inject({ method: 'POST', url: '/api/profile/mcp-tokens', payload: { label: 'x' } }),
      await h.app.inject({ method: 'DELETE', url: '/api/profile/mcp-tokens/whatever' }),
      await h.app.inject({ method: 'GET', url: '/api/profile/mcp-calls' }),
    ]) {
      expect(response.statusCode).toBe(401)
    }
  })
})

// Important 5 of the M4 review: a token minted from a session used to outlive every one of the
// three ways this app can change what proves an account's identity. Nothing here is about the
// Profile card - it is about the credential still working, or not, afterwards.
describe('a password change ends every MCP token the account holds', () => {
  it('own password change: a previously working token is refused at POST /mcp afterwards', async () => {
    const { secret, id } = h.mintMcpToken()
    expect(await usable(secret)).toBe(true)

    const changed = await h.app.inject({
      method: 'PUT', url: '/api/profile/password', headers: auth(session),
      payload: { currentPassword: 'a good long password', newPassword: 'a different good long password' },
    })
    expect(changed.statusCode).toBe(204)

    expect(await usable(secret)).toBe(false)
    // A stamp, not a delete: the row survives so the call log this token made still resolves to
    // an account, the same guarantee `revoke` already gives a caller-initiated revocation.
    const rows = (await list(session)).json().tokens as { id: string, revokedAtMs: number | null }[]
    // And why, which the card turns into "your password was changed": without it an owner whose
    // agent went dark saw only a date.
    expect(rows).toEqual([expect.objectContaining({
      id, revokedAtMs: expect.any(Number), revokedReason: 'password_changed',
    })])
  })

  it('admin reset: a member\'s previously working token is refused at POST /mcp afterwards', async () => {
    const bob = await h.addPerson({ id: 'p-bob', displayName: 'Bob', username: 'bob' })
    const { secret } = h.mintMcpToken({ accountId: bob.accountId })
    expect(await usable(secret)).toBe(true)

    const reset = await h.app.inject({
      method: 'POST', url: `/api/members/${bob.accountId}/password`,
      headers: auth(session), payload: { password: 'the admin chose this one' },
    })
    expect(reset.statusCode).toBe(204)

    expect(await usable(secret)).toBe(false)
    // password_reset, not password_changed: Bob did not do this himself, which is the case he
    // most needs told when his agent stops working.
    const [row] = h.app.haelan.stores.mcpTokens.listForAccount(bob.accountId)
    expect(row?.revokedReason).toBe('password_reset')
  })
})
