import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MCP_TOKEN_PREFIX, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

const MCP_HEADERS = {
  'content-type': 'application/json',
  // Both, always. The SDK's transport refuses a client that accepts only JSON with a 406, even
  // with enableJsonResponse set. Measured, and documented in TOOLS.md for the same reason.
  accept: 'application/json, text/event-stream',
}

// The admin this harness creates in completeSetup, named rather than looked up. accounts.list()
// is ordered by username, so list()[0] silently stops being the admin as soon as a test adds an
// account sorting before 'robin' - which two cases below do.
const ADMIN_ACCOUNT = 'a1'
const ADMIN_PERSON = 'p1'

let h: Harness
beforeEach(async () => {
  h = await withServer()
  await h.completeSetup()
})
afterEach(async () => { await h.cleanup() })

const rpc = (secret: string | null, body: Record<string, unknown>) => h.app.inject({
  method: 'POST',
  url: '/mcp',
  headers: { ...MCP_HEADERS, ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) },
  payload: body,
})

const toolsCall = (secret: string | null, name: string, args: Record<string, unknown> = {}) =>
  rpc(secret, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

describe('POST /mcp', () => {
  it('answers a real MCP call with a JSON-RPC result', async () => {
    const { secret } = h.mintMcpToken()
    const response = await toolsCall(secret, 'describe_person')

    expect(response.statusCode).toBe(200)
    const payload = response.json() as { result?: { structuredContent?: { personId?: string } } }
    expect(typeof payload.result?.structuredContent?.personId).toBe('string')
  })

  it('lists every tool in the catalogue', async () => {
    const { secret } = h.mintMcpToken()
    const response = await rpc(secret, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

    expect(response.statusCode).toBe(200)
    const names = (response.json() as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    expect(names).toContain('describe_person')
    expect(names).toContain('get_workout')
  })

  it('needs no initialize first, because the transport is stateless', async () => {
    const { secret } = h.mintMcpToken()
    // No handshake on this connection and no session id anywhere: a second POST with a fresh
    // transport answers as fully as the first. That is the property the design chose, and the one
    // a stateful transport would have taken away.
    expect((await toolsCall(secret, 'list_metrics')).statusCode).toBe(200)
    expect((await toolsCall(secret, 'list_metrics')).statusCode).toBe(200)
  })

  it('writes one call row naming the tool, and no arguments anywhere', async () => {
    const { secret, id } = h.mintMcpToken()
    await toolsCall(secret, 'describe_person')

    const accountId = ADMIN_ACCOUNT
    const calls = h.app.haelan.stores.mcpCalls.listForAccount(accountId, 10)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tokenId).toBe(id)
    expect(calls[0]!.tool).toBe('describe_person')
    expect(calls[0]!.outcome).toBe('ok')
    expect(calls[0]!.rowCount).toBeGreaterThanOrEqual(0)
    expect(calls[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('before the first token exists', () => {
  it('answers exactly as an unregistered path does, byte for byte', async () => {
    const present = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const absent = await h.app.inject({
      method: 'POST', url: '/mcp-not-a-route', headers: MCP_HEADERS,
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })

    expect(present.statusCode).toBe(404)
    // The path is the only difference. Normalised rather than compared loosely, because "it is
    // also a 404" is not the claim - the claim is that a prober cannot tell the two apart, and a
    // differently shaped 404 body would give it away while both statuses still read 404.
    expect(present.body).toBe(absent.body.replace('/mcp-not-a-route', '/mcp'))
  })

  it('vanishes for a POST with no content-type too, which is where a preHandler guard would leak a 415', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/mcp', payload: 'not json at all' })
    expect(response.statusCode).toBe(404)
  })

  it('is not turned into the setup gate 409, because /mcp is outside the gate', async () => {
    const midWizard = await withServer()
    const response = await midWizard.app.inject({
      method: 'POST', url: '/mcp', headers: MCP_HEADERS,
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })
    // Cleanup before the assertion, not in a finally: this closes a database handle, and an EPERM
    // from cleanup running after a failed expect would replace the real assertion error.
    await midWizard.cleanup()
    expect(response.statusCode).toBe(404)
  })
})

describe('once a token exists', () => {
  it('answers 401 to a caller with no credential, rather than 404', async () => {
    h.mintMcpToken()
    const response = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: { kind: 'unauthorized', code: 'no_mcp_token', message: expect.any(String) },
    })
  })

  it('answers 401 to a token this instance never issued', async () => {
    h.mintMcpToken()
    const response = await toolsCall(`${MCP_TOKEN_PREFIX}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, 'list_metrics')
    expect(response.statusCode).toBe(401)
  })

  it('refuses an expired token and records the refusal', async () => {
    const { secret, id } = h.mintMcpToken({ days: 30 })
    h.clock.nowMs += 31 * 86_400_000

    expect((await toolsCall(secret, 'list_metrics')).statusCode).toBe(401)

    const accountId = ADMIN_ACCOUNT
    const [call] = h.app.haelan.stores.mcpCalls.listForAccount(accountId, 10)
    // A leaked token's first sign is usually a failure, so the log has to hold one.
    expect(call).toMatchObject({ tokenId: id, tool: null, outcome: 'refused' })
  })

  it('refuses a revoked token', async () => {
    const { secret, id } = h.mintMcpToken()
    const accountId = ADMIN_ACCOUNT
    h.app.haelan.stores.mcpTokens.revoke({ id, accountId, nowMs: h.clock.nowMs })

    expect((await toolsCall(secret, 'list_metrics')).statusCode).toBe(401)
  })

  it('writes no row for a secret that matches nothing, so a guesser cannot grow the log', async () => {
    h.mintMcpToken()
    await toolsCall(`${MCP_TOKEN_PREFIX}nope`, 'list_metrics')
    expect(h.app.haelan.instance.db.select().from(schema.mcpCalls).all()).toEqual([])
  })

  it('moves lastUsedAtMs on an accepted call and not on a refused one', async () => {
    const { secret, id } = h.mintMcpToken()
    const accountId = ADMIN_ACCOUNT
    const read = () => h.app.haelan.stores.mcpTokens.listForAccount(accountId)
      .find((t) => t.id === id)!.lastUsedAtMs

    expect(read()).toBeNull()
    await toolsCall(secret, 'list_metrics')
    expect(read()).toBe(h.clock.nowMs)

    const used = read()
    h.clock.nowMs += 60_000
    await toolsCall(`${MCP_TOKEN_PREFIX}nope`, 'list_metrics')
    expect(read()).toBe(used)
  })

  it('stops working when the account is suspended', async () => {
    const wilma = await h.addPerson({ id: 'p2', displayName: 'Wilma', username: 'wilma' })
    const { secret } = h.mintMcpToken({ accountId: wilma.accountId })
    expect((await toolsCall(secret, 'list_metrics')).statusCode).toBe(200)

    h.app.haelan.stores.accounts.disable(wilma.accountId, h.clock.nowMs)
    expect((await toolsCall(secret, 'list_metrics')).statusCode).toBe(401)
  })
})

describe('the two credential kinds are not interchangeable', () => {
  it('refuses a session id at /mcp', async () => {
    h.mintMcpToken()
    const sessionId = await h.signIn()
    // The same header, the same shape, the same length - and a different store behind it. This is
    // the test that would go green the day somebody "simplified" the guard into requireSession.
    expect((await toolsCall(sessionId, 'list_metrics')).statusCode).toBe(401)
  })

  it('refuses an MCP token at /api/v1 and at the flat surface', async () => {
    const { secret } = h.mintMcpToken()
    const personId = ADMIN_PERSON
    const header = { authorization: `Bearer ${secret}` }

    const versioned = await h.app.inject({
      method: 'GET', url: `/api/v1/p/${personId}/data-types`, headers: header,
    })
    expect(versioned.statusCode).toBe(401)

    const flat = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: header })
    expect(flat.statusCode).toBe(401)
  })
})

describe('the transport', () => {
  it('refuses a client that will not accept an event stream, which is what a caller gets wrong first', async () => {
    const { secret } = h.mintMcpToken()
    const response = await h.app.inject({
      method: 'POST', url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${secret}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })
    // 406, and a JSON-RPC error rather than this app's envelope: the guard has already passed, so
    // from here the framing is MCP's. Pinned because it is the one refusal a new caller will
    // actually meet, and because TOOLS.md promises this header.
    expect(response.statusCode).toBe(406)
    expect(response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: expect.any(Number) } })
  })

  it('has no GET, so nothing can open a stream against it', async () => {
    h.mintMcpToken()
    const response = await h.app.inject({ method: 'GET', url: '/mcp', headers: { accept: 'text/event-stream' } })
    expect(response.statusCode).toBe(404)
  })

  it('reports a tool refusal as a JSON-RPC result with isError, and logs it', async () => {
    const { secret } = h.mintMcpToken()
    const response = await toolsCall(secret, 'get_workout', { sessionId: 'no-such-session' })

    expect(response.statusCode).toBe(200)
    expect((response.json() as { result: { isError?: boolean } }).result.isError).toBe(true)

    const accountId = ADMIN_ACCOUNT
    const [call] = h.app.haelan.stores.mcpCalls.listForAccount(accountId, 10)
    expect(call).toMatchObject({ tool: 'get_workout', outcome: 'error', rowCount: null })
  })
})

describe('the log cannot hold free text', () => {
  it('records nothing of what search_notes was asked to look for', async () => {
    const { secret } = h.mintMcpToken()
    const sentinel = 'zzz-a-word-nobody-would-say-aloud-zzz'
    await toolsCall(secret, 'search_notes', { from: '2026-08-01', to: '2026-08-01', contains: sentinel })

    // Every column of every row, serialised. This pins the schema rather than a filter: there is
    // no column for an argument value, so no future filter can be removed and no future field can
    // quietly start carrying one.
    const rows = h.app.haelan.instance.db.select().from(schema.mcpCalls).all()
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows)).not.toContain(sentinel)
  })
})
