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
    expect(rows).toEqual([expect.objectContaining({ id: mine.token.id, revokedAtMs: h.clock.nowMs })])
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
