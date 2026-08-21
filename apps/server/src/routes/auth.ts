import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { SESSION_COOKIE, setSessionCookie, clearSessionCookie } from '../auth/cookie.ts'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

declare module 'fastify' {
  interface FastifyRequest { accountId: string | null }
  interface FastifyInstance {
    requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('accountId', null)

  // SameSite=lax already blocks a cross site form POST. This closes the gap for clients that
  // send Origin but not the cookie policy we assumed. Same origin, or no Origin, passes.
  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATING.has(request.method)) return
    const origin = request.headers.origin
    if (typeof origin !== 'string' || origin === '') return
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return reply.code(403).send({ error: 'bad_origin' })
    }
    if (originHost !== request.headers.host) return reply.code(403).send({ error: 'bad_origin' })
  })

  app.decorate('requireSession', async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = request.cookies[SESSION_COOKIE]
    const accountId = raw ? app.haelan.stores.sessions.resolve(raw, app.haelan.now()) : null
    if (!accountId) {
      clearSessionCookie(reply)
      return reply.code(401).send({ error: 'no_session' })
    }
    request.accountId = accountId
  })

  app.post<{ Body: { username?: unknown, password?: unknown } }>('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'username and password are required' })
    }
    const result = await app.haelan.stores.accounts.login({ username, password, nowMs: app.haelan.now() })
    if (!result.ok) {
      return result.reason === 'locked'
        ? reply.code(423).send({ error: 'locked' })
        : reply.code(401).send({ error: 'invalid_credentials' })
    }
    setSessionCookie(request, reply, app.haelan.stores.sessions.create(result.account.id, app.haelan.now()))
    return reply.send({ personId: result.account.personId, username: result.account.username })
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE]
    if (raw) app.haelan.stores.sessions.destroy(raw)
    clearSessionCookie(reply)
    return reply.code(204).send()
  })

  app.get('/api/auth/me', { preHandler: [app.requireSession] }, async (request, reply) => {
    const account = request.accountId ? app.haelan.stores.accounts.getById(request.accountId) : null
    if (!account) return reply.code(401).send({ error: 'no_session' })
    const person = app.haelan.stores.people.get(account.personId)
    return reply.send({
      personId: account.personId,
      displayName: person?.displayName ?? account.username,
      username: account.username,
      isAdmin: account.isAdmin,
    })
  })
}
