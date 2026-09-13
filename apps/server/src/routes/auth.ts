import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { SESSION_COOKIE, setSessionCookie, clearSessionCookie } from '../auth/cookie.ts'
import { bearerToken } from '../auth/bearer.ts'
import { errorBody } from '../api/envelope.ts'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

declare module 'fastify' {
  interface FastifyRequest { accountId: string | null }
  interface FastifyInstance {
    /** The one session guard, for every route family including /api/v1. */
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
      return reply.code(403).send(errorBody('forbidden', 'bad_origin', 'the origin header does not match this instance'))
    }
    if (originHost !== request.headers.host) {
      return reply.code(403).send(errorBody('forbidden', 'bad_origin', 'the origin header does not match this instance'))
    }
  })

  app.decorate('requireSession', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // The header wins when present: a native client that sent one meant it, and a stale cookie
    // riding along on the same connection must not silently decide who the caller is. Only a
    // cookie failure clears the cookie, so a bearer caller never logs out a browser session that
    // happens to share the connection.
    const bearer = bearerToken(request.headers.authorization)
    if (bearer !== null) {
      const accountId = app.haelan.stores.sessions.resolve(bearer, app.haelan.now())
      if (!accountId) {
        return reply.code(401).send(errorBody('unauthorized', 'no_session', 'sign in required'))
      }
      request.accountId = accountId
      return
    }
    const raw = request.cookies[SESSION_COOKIE]
    const accountId = raw ? app.haelan.stores.sessions.resolve(raw, app.haelan.now()) : null
    if (!accountId) {
      clearSessionCookie(reply)
      return reply.code(401).send(errorBody('unauthorized', 'no_session', 'sign in required'))
    }
    request.accountId = accountId
  })

  app.post<{ Body: { username?: unknown, password?: unknown } }>('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string') {
      return reply.code(400).send(errorBody('config', 'config', 'username and password are required'))
    }
    const result = await app.haelan.stores.accounts.login({ username, password, nowMs: app.haelan.now() })
    if (!result.ok) {
      // 423 is not in STATUS_BY_KIND - there is no kind for "locked", only a status. The kind
      // stays 'unauthorized' because that is the family this refusal belongs to; the code says
      // which member of it.
      return result.reason === 'locked'
        ? reply.code(423).send(errorBody('unauthorized', 'locked', 'this account is locked'))
        : reply.code(401).send(errorBody('unauthorized', 'invalid_credentials', 'invalid username or password'))
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
    if (!account) return reply.code(401).send(errorBody('unauthorized', 'no_session', 'sign in required'))
    const person = app.haelan.stores.people.get(account.personId)
    return reply.send({
      personId: account.personId,
      displayName: person?.displayName ?? account.username,
      username: account.username,
      isAdmin: account.isAdmin,
      // The browser resolves the person's today from this rather than from its own clock's zone.
      timezone: person?.timezone ?? 'UTC',
      // The two inputs the cardio load model needs and nothing else in the app reads. Both are
      // computed at read time from these, so neither carries the timezone's rebuild machinery.
      birthDate: person?.birthDate ?? null,
      sex: person?.sex ?? null,
      // Whether this person has a *usable* Google connection - a credentials row whose token was
      // never revoked, matching listConnectedPeople's own predicate. A revoked row is not a
      // connection in any sense the UI cares about: it cannot sync, so it must show the same
      // connect control an invited member with no credentials at all would see. On the session
      // payload rather than behind its own route because the Shell reads this before it can
      // render anything: until M5f nothing in the app linked to /oauth/start except the setup
      // wizard.
      connected: app.haelan.stores.credentials.isConnected(account.personId),
      // A row exists, was never revoked, and instance.key still cannot open it - the state a
      // restored backup leaves behind, since runBackup copies the database and nothing else,
      // and a key generated on the machine that restores it will not be the key that sealed
      // this row. `connected` above is already correctly false for this person and drives the
      // same reconnect control a never-connected person sees; this field exists only so that
      // control, or an operator looking at it, can say why rather than leaving "why do I have
      // to reconnect" unanswered.
      credentialsUnreadable: app.haelan.stores.credentials.isCredentialsUnreadable(account.personId),
      // The address Google will send anyone back to. The client compares it against its own
      // origin, which is the only reliable way to tell before consent that the redirect cannot
      // land - and after consent is far too late, because access has already been granted.
      baseUrl: app.haelan.stores.settings.get()?.baseUrl ?? '',
    })
  })
}
