import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'
import { CATALOGUE } from '../src/mcp/catalogue.ts'
import { ALICE_FINGERPRINTS, BART_FINGERPRINTS, TOOL_INPUTS, seedToolData } from './mcp-fixtures.ts'

/**
 * The sixth isolation file, and the one that asks the question over the wire: a token minted for
 * alice's account, every tool in CATALOGUE called through POST /mcp, and nothing of bart's in any
 * answer.
 *
 * Catalogue-driven for the same reason `mcp-isolation.test.ts` is: a tool added later is covered
 * without anyone remembering this file exists. That file proves the binding; this one proves the
 * remote surface actually applies it - that the person comes from the token's account and from
 * nothing in the request.
 */

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

let h: Harness
let aliceSecret: string

beforeEach(async () => {
  h = await withServer()
  await h.completeSetup()
  const alice = await h.addPerson({ id: 'alice', displayName: 'Alice', username: 'alice' })
  await h.addPerson({ id: 'bart', displayName: 'Bart', username: 'bart' })
  seedToolData(h.app.haelan.instance.db)
  aliceSecret = h.mintMcpToken({ accountId: alice.accountId }).secret
})
afterEach(async () => { await h.cleanup() })

const call = (name: string, args: Record<string, unknown>) => h.app.inject({
  method: 'POST', url: '/mcp',
  headers: { ...MCP_HEADERS, authorization: `Bearer ${aliceSecret}` },
  payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
})

describe('every tool over POST /mcp, bound by a token, proved against a second person', () => {
  for (const tool of CATALOGUE) {
    it(`${tool.name} never answers with another person's data`, async () => {
      const args = TOOL_INPUTS[tool.name]
      if (args === undefined) {
        throw new Error(
          `no representative input for tool '${tool.name}' in TOOL_INPUTS in mcp-fixtures.ts — `
          + "add one rather than letting a tool go uncovered by this file's guarantee",
        )
      }

      const response = await call(tool.name, args)
      expect(response.statusCode).toBe(200)
      // The whole response body, not the structured content alone: the summary sentence and the
      // serialised JSON block travel in it too, and a leak into either is a leak.
      for (const fingerprint of BART_FINGERPRINTS) {
        expect(response.body).not.toContain(fingerprint)
      }
    })
  }

  // The suite's own floor. Without this, a route that resolved to nobody would answer thirteen
  // empty results, contain none of bart's fingerprints, and pass - which is the one way this file
  // could be green and worthless.
  it("answers with alice's own data, so the absence of bart's means something", async () => {
    const missing: string[] = []
    for (const [name, fingerprint] of Object.entries(ALICE_FINGERPRINTS)) {
      const response = await call(name, TOOL_INPUTS[name]!)
      if (!response.body.includes(fingerprint)) {
        missing.push(`${name} did not answer with ${fingerprint}: ${response.body.slice(0, 300)}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("refuses bart's session id presented under alice's token", async () => {
    const response = await call('get_workout', { sessionId: 'bart-run' })

    expect(response.statusCode).toBe(200)
    expect((response.json() as { result: { isError?: boolean } }).result.isError).toBe(true)
    // The refusal may echo the id the caller supplied - they already had it - but nothing else of
    // bart's may ride along in the message.
    for (const fingerprint of ['bart-watch', 'bart-night', 'bart-note-sentinel', 'bart-event-sentinel', '8800', '176']) {
      expect(response.body).not.toContain(fingerprint)
    }
  })
})
