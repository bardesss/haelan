import type { FastifyInstance, FastifyRequest } from 'fastify'
import { errorBody, sendCoreError, statusFor } from '../api/envelope.ts'
import { isKnownTimezone } from './setup.ts'

interface ProfileBody { displayName?: unknown, username?: unknown, timezone?: unknown }
interface PasswordBody { currentPassword?: unknown, newPassword?: unknown }

/**
 * The caller's own account, and the only surface on which any of it can be changed. Until this
 * existed, every field below was written once by the setup wizard or by an invite redemption and
 * then fixed for the life of the instance.
 *
 * requireSession alone, deliberately, where the rest of /api/settings is admin gated: these four
 * values belong to whoever is asking. The account acted on is never named in the path or the body
 * - it is the one the session resolves to - so there is no id for a crafted request to point
 * somewhere else, which is the same arrangement /api/auth/me already relies on.
 */
export function registerProfile(app: FastifyInstance): void {
  const stores = () => app.haelan.stores

  // A scope of its own, the same device registerInviteRoutes and registerMaintenance use, so this
  // error handler catches only what these two routes throw. AccountStore and PeopleStore refuse a
  // taken username, an empty name and a short password by throwing ConfigError, and sendCoreError
  // is the shared mapping from that to the envelope - registering it here is what lets the
  // handlers below let those throws travel rather than re-deriving the same catch twice.
  void app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => sendCoreError(reply, error))

    scope.put<{ Body: ProfileBody }>('/api/profile', { preHandler: [scope.requireSession] }, async (request, reply) => {
      const account = stores().accounts.getById(callerAccountId(request))
      if (!account) {
        return reply.code(statusFor('unauthorized')).send(errorBody('unauthorized', 'no_session', 'sign in required'))
      }
      const person = stores().people.get(account.personId)
      if (!person) {
        return reply.code(statusFor('not_found')).send(errorBody('not_found', 'no_such_person', 'this account has no person row'))
      }

      const { displayName, username, timezone } = request.body ?? {}
      // Each field is optional and absent means untouched, so a client can save one control
      // without restating the other two. A present field must still be a string: `undefined` and
      // `null` are different answers here, and treating the second as "leave it" would let a
      // client blank a name by sending a value it thinks it is setting.
      for (const [name, value] of [['displayName', displayName], ['username', username], ['timezone', timezone]] as const) {
        if (value !== undefined && typeof value !== 'string') {
          return reply.code(statusFor('config')).send(errorBody('config', 'config', `${name} must be text`))
        }
      }
      if (typeof timezone === 'string' && !isKnownTimezone(timezone)) {
        return reply.code(statusFor('config')).send(errorBody('config', 'config', `unknown timezone ${timezone}`))
      }

      // The zone comparison is against what is stored, not against whether the field was sent.
      // Saving the form unchanged sends all three every time, and a timezone write costs this
      // person every derived row they have until a rebuild replays them (PeopleStore.setTimezone),
      // so "somebody pressed save" must never be mistaken for "the day boundary moved".
      const zoneMoved = typeof timezone === 'string' && timezone !== person.timezone

      if (typeof displayName === 'string') stores().people.setDisplayName(person.id, displayName)
      // Before the timezone write rather than after: a taken username throws, and the throw has to
      // land before anything has marked this person for an eleven minute rebuild they did not get.
      if (typeof username === 'string') stores().accounts.setUsername(account.id, username)
      if (zoneMoved) stores().people.setTimezone(person.id, timezone)

      const saved = stores().people.get(person.id)!
      const savedAccount = stores().accounts.getById(account.id)!
      return reply.send({
        displayName: saved.displayName,
        username: savedAccount.username,
        timezone: saved.timezone,
        // What the caller is owed rather than what happened: nothing rebuilds on this request. The
        // derivation stamp is cleared, which is what the boot rebuild reads, so this says "your
        // history is being re-derived from the archive the next time this instance starts" and the
        // panel has something honest to print.
        rebuildPending: zoneMoved,
      })
    })

    /**
     * The current password, always, even though the caller already holds a session.
     *
     * Not to protect the database - they are signed in, and everything the new password would
     * unlock is already on their screen. It is the permanence that is being guarded: a session
     * left open on an unlocked laptop is worth as long as that cookie lasts, and a password change
     * turns that into the account itself, for good, with the real owner locked out and no reset
     * link on an instance that sends no mail.
     */
    scope.put<{ Body: PasswordBody }>('/api/profile/password', { preHandler: [scope.requireSession] }, async (request, reply) => {
      const accountId = callerAccountId(request)
      const { currentPassword, newPassword } = request.body ?? {}
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        return reply.code(statusFor('config'))
          .send(errorBody('config', 'config', 'currentPassword and newPassword are required'))
      }
      if (!await stores().accounts.verifyPassword(accountId, currentPassword)) {
        // 'forbidden' rather than 'unauthorized': the session is fine and must survive this, where
        // a 401 is what the client signs out on (see queryClient.tsx). The code says which refusal
        // it is, so a panel can say "that is not your current password" rather than "forbidden".
        return reply.code(statusFor('forbidden'))
          .send(errorBody('forbidden', 'wrong_password', 'that is not your current password'))
      }
      await stores().accounts.setPasswordById(accountId, newPassword)
      // Every MCP token this account has minted ends here, unlike its sessions two lines below,
      // which survive. The tokens were minted by whoever held a session at the time, and this
      // password change is the act of someone who believes that person may not have been them -
      // the whole reason to change a password after noticing a break-in. A session surviving is a
      // choice (see the comment below); an agent credential surviving the same button press would
      // leave the thing the person is actually worried about untouched.
      stores().mcpTokens.revokeAllForAccount(accountId, app.haelan.now())
      // No 200 body worth sending, and nothing the client should re-read: the session survives
      // (auth_sessions keys on the account id, not on anything this touched) and every other
      // session this account holds survives too. Signing the others out would be a defensible
      // policy and is not this one - it needs a way to tell somebody why they were signed out,
      // which an instance with no mail server does not have.
      return reply.code(204).send()
    })
  })
}

/**
 * requireSession has already answered its own 401 for a missing session before any handler above
 * runs, so request.accountId is a real account id here. The decoration itself stays nullable (see
 * auth.ts): it is set once for the whole app and cannot be narrowed to what one preHandler chain
 * guarantees. The same cast, for the same reason, as members.ts's own callerAccountId.
 */
function callerAccountId(request: FastifyRequest): string {
  return request.accountId as string
}
