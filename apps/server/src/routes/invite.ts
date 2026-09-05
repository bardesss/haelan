import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { errorBody, sendCoreError, statusFor } from '../api/envelope.ts'
import { setSessionCookie } from '../auth/cookie.ts'

interface InviteParams { token: string }
interface RedeemBody { username?: unknown, password?: unknown }

// Unauthenticated on purpose, and the only pair in the app besides /api/auth/login that is: the
// member holding this link has no account yet, so there is no session to require. Every other
// route family guards first and answers second; these two answer first because for them there is
// nothing to guard.
export function registerInviteRoutes(app: FastifyInstance): void {
  // One answer for every way a token can fail to resolve, matching findByToken's own one query,
  // one shape: unknown, expired, revoked and already-redeemed all read the same to whoever is
  // holding the link, and a different answer for one of them would tell a prober which tokens
  // once existed.
  const notFound = () => errorBody('not_found', 'no_such_invite', 'this invite is no longer valid')

  // A scope of its own, the same device registerV1 uses for the versioned surface, so that
  // setErrorHandler below catches only what these two routes throw. AccountStore.create throws
  // ConfigError for a taken username or a short password, and sendCoreError is the shared mapping
  // from that to the { kind, code, message } shape - registering it here means the POST handler
  // below can let the throw travel instead of re-deriving setup.ts's own ad hoc catch.
  void app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => sendCoreError(reply, error))

    scope.get<{ Params: InviteParams }>('/api/invite/:token', async (request, reply) => {
      const invite = app.haelan.instance.invites.findByToken(request.params.token, app.haelan.now())
      if (!invite) return reply.code(statusFor('not_found')).send(notFound())
      const person = app.haelan.stores.people.get(invite.personId)
      if (!person) return reply.code(statusFor('not_found')).send(notFound())
      return reply.send({ displayName: person.displayName, timezone: person.timezone })
    })

    scope.post<{ Params: InviteParams, Body: RedeemBody }>('/api/invite/:token', async (request, reply) => {
      const invite = app.haelan.instance.invites.findByToken(request.params.token, app.haelan.now())
      if (!invite) return reply.code(statusFor('not_found')).send(notFound())

      const { username, password } = request.body ?? {}
      if (typeof username !== 'string' || typeof password !== 'string') {
        return reply.code(statusFor('config')).send(errorBody('config', 'config', 'username and password are required'))
      }

      const now = app.haelan.now()
      // Create, then mark redeemed, then set the cookie, in that order. If create throws, the
      // invite has not been touched yet, so it stays usable - this ordering is what gives that
      // for free. Redeeming first would burn the member's only link on a typo'd password.
      //
      // isAdmin is always false and is not read from the body: an invite has no way to ask for
      // admin, so redeeming one can never mint a second one. is_admin governs the OAuth client
      // and every instance-level setting, so a second admin created by accident is the failure
      // this route is built to make impossible rather than merely unlikely.
      const account = await app.haelan.stores.accounts.create({
        id: randomUUID(),
        personId: invite.personId,
        username,
        password,
        isAdmin: false,
        nowMs: now,
      })
      app.haelan.instance.invites.markRedeemed(invite.id, now)
      setSessionCookie(request, reply, app.haelan.stores.sessions.create(account.id, now))
      return reply.code(201).send({ personId: account.personId, username: account.username })
    })
  })
}
