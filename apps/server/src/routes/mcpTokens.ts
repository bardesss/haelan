import { randomUUID } from 'node:crypto'
import { DEFAULT_MCP_TOKEN_DAYS } from '@haelan/core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { errorBody, sendCoreError, statusFor } from '../api/envelope.ts'

interface MintBody { label?: unknown, days?: unknown }

/**
 * How many calls the card shows. An audit trail nobody looks at detects nothing, and a
 * thousand-row list is one nobody looks at.
 */
const RECENT_CALLS = 20

/**
 * The caller's own MCP tokens, and the only surface on which one can be minted.
 *
 * `requireSession` alone, like the Profile routes beside these and for the same reason: the
 * account acted on is never named in a path or a body, it is the one the session resolves to.
 *
 * **There is deliberately no admin path to another member's token.** An admin can already reset a
 * member's password and sign in as them - but that is loud: the member's own password stops
 * working and they find out. Minting a token for them would be the same access, silently, with
 * nothing they would notice. So every route to a member's data stays either theirs or visible to
 * them, and that property is worth more than the convenience of setting an agent up for somebody
 * else.
 */
export function registerMcpTokenRoutes(app: FastifyInstance): void {
  const stores = () => app.haelan.stores

  void app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => sendCoreError(reply, error))

    scope.get('/api/profile/mcp-tokens', { preHandler: [scope.requireSession] }, async (request, reply) =>
      reply.send({ tokens: stores().mcpTokens.listForAccount(callerAccountId(request)) }))

    scope.post<{ Body: MintBody }>('/api/profile/mcp-tokens', { preHandler: [scope.requireSession] }, async (request, reply) => {
      const { label, days } = request.body ?? {}
      if (typeof label !== 'string') {
        return reply.code(statusFor('config')).send(errorBody('config', 'config', 'a token needs a label'))
      }
      if (days !== undefined && typeof days !== 'number') {
        return reply.code(statusFor('config')).send(errorBody('config', 'config', 'days must be a number'))
      }
      // The store owns which lives are offered and which labels are acceptable, and throws
      // ConfigError for both - this handler restates neither rule, so the two cannot drift.
      const { token, secret } = stores().mcpTokens.create({
        id: randomUUID(), accountId: callerAccountId(request), label,
        days: days ?? DEFAULT_MCP_TOKEN_DAYS, nowMs: app.haelan.now(),
      })
      // 201, and the secret here and nowhere else. Nothing reads it back, so a member who loses it
      // mints another rather than recovering this one.
      return reply.code(201).send({ token, secret })
    })

    scope.delete<{ Params: { id: string } }>('/api/profile/mcp-tokens/:id', { preHandler: [scope.requireSession] }, async (request, reply) => {
      const revoked = stores().mcpTokens.revoke({
        id: request.params.id, accountId: callerAccountId(request), nowMs: app.haelan.now(),
      })
      // One answer for a token that does not exist and one that belongs to another member: the
      // caller has no business learning which of the two it was.
      if (!revoked) {
        return reply.code(statusFor('not_found')).send(errorBody('not_found', 'no_such_token', 'no token of yours has that id'))
      }
      return reply.code(204).send()
    })

    scope.get('/api/profile/mcp-calls', { preHandler: [scope.requireSession] }, async (request, reply) =>
      reply.send({ calls: stores().mcpCalls.listForAccount(callerAccountId(request), RECENT_CALLS) }))
  })
}

/**
 * requireSession has already answered its own 401 before any handler above runs. The same cast,
 * for the same reason, as members.ts's and profile.ts's own callerAccountId.
 */
function callerAccountId(request: FastifyRequest): string {
  return request.accountId as string
}
