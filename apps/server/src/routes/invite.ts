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
      // Claimed first, not marked redeemed after create succeeds: two concurrent POSTs on one
      // token both pass findByToken's check above, and claimRedemption's conditional UPDATE is
      // what settles which of them gets to try creating an account at all - the loser's WHERE
      // matches nothing and falls straight to the same 404 every other invalid token gets, rather
      // than racing accounts.person_id UNIQUE and surfacing as a generic 500.
      if (!app.haelan.instance.invites.claimRedemption(invite.id, now)) {
        return reply.code(statusFor('not_found')).send(notFound())
      }
      // isAdmin is always false and is not read from the body: an invite has no way to ask for
      // admin, so redeeming one can never mint a second one. is_admin governs the OAuth client
      // and every instance-level setting, so a second admin created by accident is the failure
      // this route is built to make impossible rather than merely unlikely.
      let account
      try {
        account = await app.haelan.stores.accounts.create({
          id: randomUUID(),
          personId: invite.personId,
          username,
          password,
          isAdmin: false,
          nowMs: now,
        })
      } catch (error) {
        // The claim above already burned the flag; undo it so a typo'd password or a taken
        // username does not cost the member their only link, the same "still usable" guarantee
        // the old create-then-mark ordering gave for free.
        app.haelan.instance.invites.releaseRedemption(invite.id)
        throw error
      }
      setSessionCookie(request, reply, app.haelan.stores.sessions.create(account.id, now))
      return reply.code(201).send({ personId: account.personId, username: account.username })
    })
  })
}
