import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PendingInvite } from '@haelan/core'
import { errorBody, statusFor } from '../api/envelope.ts'
import { isKnownTimezone } from './setup.ts'

interface CreateMemberBody { displayName?: unknown, timezone?: unknown }
interface AccountParams { accountId: string }
interface InviteParams { id: string }

export type MemberState = 'active' | 'invited' | 'disabled'

export interface MemberRow {
  personId: string
  displayName: string
  timezone: string
  accountId: string | null
  username: string | null
  isAdmin: boolean
  state: MemberState
  inviteId: string | null
}

// This family answers { error: { kind, code, message } } like /api/v1, not the flat { error:
// 'a string' } settings.ts and its neighbours use. There is no existing client reading these
// routes yet - the admin screen that calls them is built alongside - so there is nothing to
// break by starting on the newer shape, and M5e's migration then has three old families left to
// move rather than four.
export function registerMemberRoutes(app: FastifyInstance): void {
  const stores = () => app.haelan.stores

  // app.requireSession answers a missing session with settings.ts's flat { error: 'no_session' }.
  // Resolving the session through app.sessionGuard with this file's own responder instead is what
  // keeps that failure in the same envelope as everything else this file answers - the flat
  // default would otherwise be the one shape here that does not match its own comment above.
  const requireSession = app.sessionGuard((reply) => {
    reply.code(statusFor('unauthorized')).send(errorBody('unauthorized', 'no_session', 'sign in required'))
  })
  const guard = [requireSession, app.requireAdmin]

  app.get('/api/members', { preHandler: guard }, async (_request, reply) => {
    const now = app.haelan.now()
    const pendingByPerson = new Map<string, PendingInvite>()
    for (const invite of app.haelan.instance.invites.listPending(now)) pendingByPerson.set(invite.personId, invite)

    const items: MemberRow[] = stores().people.list().map((person): MemberRow => {
      const account = stores().accounts.getByPersonId(person.id)
      if (account) {
        return {
          personId: person.id,
          displayName: person.displayName,
          timezone: person.timezone,
          accountId: account.id,
          username: account.username,
          isAdmin: account.isAdmin,
          state: account.disabledAtMs === null ? 'active' : 'disabled',
          inviteId: null,
        }
      }
      const invite = pendingByPerson.get(person.id) ?? null
      return {
        personId: person.id,
        displayName: person.displayName,
        timezone: person.timezone,
        accountId: null,
        username: null,
        isAdmin: false,
        // No account and no pending invite is an expired invite nobody redeemed. The person row
        // still exists, so it stays listed rather than vanishing into a state nothing explains.
        state: 'invited',
        inviteId: invite?.id ?? null,
      }
    })
    return reply.send({ items })
  })

  app.post<{ Body: CreateMemberBody }>('/api/members', { preHandler: guard }, async (request, reply) => {
    const { displayName, timezone } = request.body ?? {}
    if (typeof displayName !== 'string' || displayName === '' || typeof timezone !== 'string') {
      return reply.code(statusFor('config'))
        .send(errorBody('config', 'config', 'displayName and timezone are required'))
    }
    if (!isKnownTimezone(timezone)) {
      return reply.code(statusFor('config'))
        .send(errorBody('config', 'config', `unknown timezone ${timezone}`))
    }

    const now = app.haelan.now()
    // The person row before the invite, the same order setup.ts creates a person before the
    // account that references it: an invite's foreign key points at the person, so the person
    // has to exist first.
    const person = stores().people.create({ id: randomUUID(), displayName, timezone, nowMs: now })
    const { invite, token } = app.haelan.instance.invites.create({
      id: randomUUID(),
      personId: person.id,
      createdByAccountId: callerAccountId(request),
      nowMs: now,
    })
    return reply.send({ personId: person.id, inviteId: invite.id, token, expiresAtMs: invite.expiresAtMs })
  })

  app.post<{ Params: AccountParams }>('/api/members/:accountId/disable', { preHandler: guard }, async (request, reply) => {
    const { accountId } = request.params
    // An instance whose only admin is locked out has no way back short of editing the database,
    // so the caller's own account is refused before it is even looked up.
    if (accountId === callerAccountId(request)) {
      return reply.code(statusFor('config'))
        .send(errorBody('config', 'config', 'an admin cannot disable their own account'))
    }
    const account = stores().accounts.getById(accountId)
    if (!account) {
      return reply.code(statusFor('not_found')).send(errorBody('not_found', 'no_such_account', `no account '${accountId}'`))
    }
    const now = app.haelan.now()
    stores().accounts.disable(accountId, now)
    // Both calls, always, in this order: without the second a suspended member stays signed in
    // until their cookie expires, which is the exact window a suspension exists to close.
    stores().sessions.destroyForAccount(accountId)
    return reply.send({ state: 'disabled' })
  })

  app.post<{ Params: AccountParams }>('/api/members/:accountId/enable', { preHandler: guard }, async (request, reply) => {
    const { accountId } = request.params
    const account = stores().accounts.getById(accountId)
    if (!account) {
      return reply.code(statusFor('not_found')).send(errorBody('not_found', 'no_such_account', `no account '${accountId}'`))
    }
    stores().accounts.enable(accountId)
    return reply.send({ state: 'active' })
  })

  app.delete<{ Params: InviteParams }>('/api/members/invites/:id', { preHandler: guard }, async (request, reply) => {
    const { id } = request.params
    const now = app.haelan.now()
    const pending = app.haelan.instance.invites.listPending(now).find((invite) => invite.id === id)
    if (!pending) {
      return reply.code(statusFor('not_found')).send(errorBody('not_found', 'no_such_invite', `no pending invite '${id}'`))
    }
    app.haelan.instance.invites.revoke(id, now)
    return reply.code(204).send()
  })
}

/**
 * requireAdmin has already resolved request.accountId to a real, admin account by the time any
 * handler above runs - a missing or unknown id stops there with its own 401, before this is ever
 * called. The decoration itself stays nullable (see auth.ts): it is set once for the whole app,
 * and its type cannot be narrowed to what only this file's preHandler chain guarantees.
 */
function callerAccountId(request: FastifyRequest): string {
  return request.accountId as string
}
