import { randomUUID } from 'node:crypto'
import { mcpTokenUsable } from '@haelan/core'
import type { McpToken } from '@haelan/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { bearerToken } from '../auth/bearer.ts'
import { errorBody, statusFor } from '../api/envelope.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** The token this request presented, once it has been accepted. Null everywhere else. */
    mcpToken: McpToken | null
  }
  interface FastifyInstance {
    /** The guard for `POST /mcp`, and the only route that uses it. Never `requireSession`. */
    requireMcpToken: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

/**
 * Its own guard, and not a widened `requireSession`.
 *
 * `auth/bearer.ts` resolves an `Authorization: Bearer` header as a **session id** - SessionStore
 * does not care which transport carried it - so the two credential kinds would otherwise be
 * interchangeable, and this unit's whole point is that they are not. An MCP token must not open
 * `/api/v1`, `/api/settings` or the Profile card; a session id must not open `/mcp`. Both
 * directions are tested (`mcp-http-auth.test.ts`).
 *
 * **Registered as an `onRequest` hook, never a `preHandler`.** Fastify parses the body before
 * `preHandler` runs, so a POST carrying a body with no `content-type` answers 415 from the parser
 * before a `preHandler` guard is ever reached - which tells an anonymous caller that this route
 * exists, on an instance whose whole mitigation is that it does not. At `onRequest` the guard runs
 * first in every case. Measured, not assumed.
 */
export function registerRequireMcpToken(app: FastifyInstance): void {
  app.decorateRequest('mcpToken', null)

  app.decorate('requireMcpToken', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { mcpTokens, mcpCalls, accounts } = app.haelan.stores
    const nowMs = app.haelan.now()

    const logRefusal = (tokenId: string): void => {
      mcpCalls.record({
        id: randomUUID(), tokenId, atMs: nowMs, tool: null,
        rowCount: null, durationMs: null, outcome: 'refused',
      })
    }

    // Before anything else, and before the credential is even looked at. An instance nobody has
    // configured answers exactly as it would if this route were not registered at all -
    // `reply.callNotFound()` produces the same body an unregistered path does, byte for byte,
    // which the app's own error envelope would not.
    //
    // This is a deliberate trade against honesty: a misconfigured instance looks like a missing
    // route rather than an unauthenticated one, and TOOLS.md says so plainly so the person
    // debugging it is not misled. What it buys is that a deployed-and-forgotten instance does not
    // advertise the surface, and there is no default credential to find.
    if (!mcpTokens.anyExist()) {
      reply.callNotFound()
      return
    }

    const presented = bearerToken(request.headers.authorization)
    // Nothing is logged for a secret that matches no row. That is not an oversight: `mcp_calls`
    // has no row to attribute it to, and writing one anyway would let an anonymous caller grow the
    // table by guessing, on a surface that is deliberately not rate limited yet. A leaked token is
    // a known row, which is the case worth seeing.
    //
    // Only that half is bounded, though: an anonymous guess writes nothing, but the holder of a
    // known token that has since expired or been revoked writes a row on every single request,
    // just as unrate-limited as the guess would have been, pruned only at the 90 day TTL
    // MCP_CALL_LOG_TTL_MS names. That is a deliberate trade, not an oversight either - the
    // revoked/expired case is exactly the one the log exists to show - but it means this surface's
    // abuse bound is "one attacker, one still-known token", not "no unbounded write path".
    const token = presented === null ? null : mcpTokens.match(presented)
    if (token === null) return refuse(reply)

    if (!mcpTokenUsable(token, nowMs)) {
      logRefusal(token.id)
      return refuse(reply)
    }

    // A suspended account's tokens stop working with it. Without this, disabling a member would
    // end their sessions (SessionStore.destroyForAccount) and leave every agent they had
    // configured still reading their data.
    //
    // The two are not symmetric, though: destroyForAccount is permanent - a re-enabled member
    // signs in fresh - while this check merely suspends. A token minted before disable is neither
    // revoked nor expired by it, so re-enabling the account resumes it exactly as it was, with
    // whatever agent the member configured able to read again without anything having been
    // reissued. Coherent, since the account is the thing that was untrusted, not the credential -
    // but an admin re-enabling somebody should know agent access comes back with everything else.
    const account = accounts.getById(token.accountId)
    if (!account || account.disabledAtMs !== null) {
      logRefusal(token.id)
      return refuse(reply)
    }

    mcpTokens.touch(token.id, nowMs)
    request.mcpToken = token
  })
}

/**
 * One answer for every way a presented token can fail: unknown, expired, revoked, and belonging to
 * a suspended account are the same to whoever is holding it, and telling them apart would tell
 * somebody probing which tokens once existed. The same rule InviteStore.findByToken follows.
 */
function refuse(reply: FastifyReply): void {
  reply.code(statusFor('unauthorized'))
    .send(errorBody('unauthorized', 'no_mcp_token', 'this surface needs a valid MCP token'))
}
