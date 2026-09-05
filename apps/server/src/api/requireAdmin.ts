import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { errorBody, statusFor } from './envelope.ts'

declare module 'fastify' {
  interface FastifyInstance {
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

/**
 * The first guard in this codebase that reads is_admin. The column has existed since the wizard
 * wrote it and has been reported to the client and consulted by nothing, so "admin" has meant a
 * label on a session payload rather than a permission. It governs instance-level settings only:
 * parent spec section 15 gives no admin an override over another person's data, and nothing here
 * changes that - a member's own data stays reachable only through their own session.
 */
export function registerRequireAdmin(app: FastifyInstance): void {
  app.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    const accountId = request.accountId
    if (!accountId) {
      return reply.code(statusFor('unauthorized')).send(errorBody('unauthorized', 'no_session', 'sign in required'))
    }
    const account = app.haelan.stores.accounts.getById(accountId)
    if (!account) {
      return reply.code(statusFor('unauthorized')).send(errorBody('unauthorized', 'no_session', 'sign in required'))
    }
    if (!account.isAdmin) {
      return reply.code(statusFor('forbidden')).send(errorBody('forbidden', 'not_admin', 'this needs an admin'))
    }
  })
}
