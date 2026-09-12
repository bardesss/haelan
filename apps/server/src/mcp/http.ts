import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { PersonQuery } from '@haelan/core'
import type { FastifyInstance } from 'fastify'
import { buildMcpServer } from './adapter.ts'

/**
 * The agent surface over HTTP: one JSON-RPC request, one response, and nothing kept between them.
 *
 * **Stateless.** No session ids, no SSE stream, no resumability. The MCP specification permits a
 * stateless server, and every tool here is a read that answers immediately - nothing streams,
 * nothing resumes, nothing is pushed. This is the first thing on this instance that listens for a
 * remote credential, and the smallest surface is the one whose security boundary can actually be
 * reasoned about.
 *
 * **Only POST is registered.** A GET delegated to this transport opens a standalone SSE stream
 * that never ends - measured: the request simply never completes. GET and DELETE therefore fall
 * through to fastify's own 404, which is both a clean refusal and the same answer this route gives
 * before the first token exists.
 *
 * **A fresh McpServer and transport per request.** That is what stateless means here, and it is
 * also what lets the call observer close over *this* request's token. Registering thirteen tools
 * costs an object and thirteen schema references; the alternative is a shared server that cannot
 * tell one caller's rows from another's.
 *
 * The guard is an `onRequest` hook, not a `preHandler` - see `guard.ts` for why, and for why it is
 * `requireMcpToken` and never `requireSession`.
 *
 * Errors split at the guard. A failure *before* the protocol - every auth failure - answers this
 * app's shared error envelope with the status it deserves, or fastify's own 404. A failure inside
 * the protocol answers a JSON-RPC error, because from there on this is MCP framing rather than
 * this project's HTTP envelope.
 */
export function registerMcp(app: FastifyInstance): void {
  app.post('/mcp', { onRequest: [app.requireMcpToken] }, async (request, reply) => {
    // Both non-null: the guard answered its own 404 or 401 before this handler was reached, and it
    // resolved the account before accepting the token.
    const token = request.mcpToken!
    const account = app.haelan.stores.accounts.getById(token.accountId)!

    // The person comes from the account, never from the request. There is no field anywhere in a
    // JSON-RPC call that names a person, which is what makes "a token answers for exactly one
    // member" a property of the shape rather than of a check somebody has to remember.
    const query = new PersonQuery(app.haelan.instance.db, account.personId)

    const server = buildMcpServer(query, (call) => {
      // Best-effort, the same as the guard's own writes (guard.ts): `mcp_calls` is an audit
      // trail, not the read this route exists to serve. A busy database - a rebuild's write
      // transaction, most plausibly - must not turn a call that already succeeded into a 500 the
      // agent reads as a failed answer, because from the caller's side it was not one.
      try {
        app.haelan.stores.mcpCalls.record({
          id: randomUUID(),
          tokenId: token.id,
          // The injected clock, so a test can place a row at a known instant. The duration beside
          // it is an elapsed measure from the adapter and is not on that clock.
          atMs: app.haelan.now(),
          tool: call.tool,
          rowCount: call.rowCount,
          durationMs: call.durationMs,
          outcome: call.outcome,
        })
      } catch (error) {
        console.error('mcp http: failed to log a call', error)
      }
    })

    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session id is generated, none is validated, and none appears in any response.
      sessionIdGenerator: undefined,
      // One JSON body back rather than an SSE stream. Note that the transport still requires the
      // client to *accept* text/event-stream and answers 406 otherwise - that is the SDK's rule
      // rather than this flag's, and TOOLS.md states it.
      enableJsonResponse: true,
    })

    // Both closed when the response is done, whether it completed or the client hung up. A server
    // per request means a leak here is a leak per request.
    reply.raw.on('close', () => { void transport.close(); void server.close() })

    await server.connect(transport)
    // From here the SDK owns the response. fastify must not also try to send one.
    reply.hijack()
    // The body fastify already parsed, handed over rather than re-read: the raw stream is spent.
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })
}
