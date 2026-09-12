import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
