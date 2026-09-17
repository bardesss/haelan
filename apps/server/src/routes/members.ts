import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PendingInvite } from '@haelan/core'
import { errorBody, sendCoreError, statusFor } from '../api/envelope.ts'

interface CreateMemberBody { displayName?: unknown }
interface ResetPasswordBody { password?: unknown }
interface AccountParams { accountId: string }
interface InviteParams { id: string }

// Not exported: apps/web declares its own copy of both (useMembers.ts's own comment says why),
// and nothing in this app imports these from here.
type MemberState = 'active' | 'invited' | 'disabled' | 'expired'

interface MemberRow {
  personId: string
  displayName: string
  timezone: string
  accountId: string | null
  username: string | null
  isAdmin: boolean
  state: MemberState
  inviteId: string | null
  /** Null until the account signs in once, and on every row that has no account yet. */
  lastLoginAtMs: number | null
  /**
   * How fresh this person's data is, as the floor rather than the ceiling, and how much of it is
   * failing. Null for a row with no account: an invited person syncs nothing, so "never synced"
   * would read as a problem rather than as the absence of one.
   */
  sync: { oldestSuccessAtMs: number | null, neverSucceeded: number, failing: number, due: number } | null
}

// This family answered { error: { kind, code, message } } from the day it was written, while
// every route outside /api/v1 still answered a flat string. That is no longer a distinction: M5e-1
// migrated the last of them, so there is one shape and this file is not special for using it.
// Kept as a note rather than deleted because it explains why these routes never needed migrating,
// and because a bespoke session guard used to live below for exactly that reason - do not add
// another. flat-surface-auth.test.ts asserts the shape on every route here.
export function registerMemberRoutes(app: FastifyInstance): void {
  const stores = () => app.haelan.stores

  const guard = [app.requireSession, app.requireAdmin]

  app.get('/api/members', { preHandler: guard }, async (_request, reply) => {
    const now = app.haelan.now()
    const pendingByPerson = new Map<string, PendingInvite>()
    for (const invite of app.haelan.instance.invites.listPending(now)) pendingByPerson.set(invite.personId, invite)

    const people = stores().people.list()
    // One query for the household rather than one per member, the way the invite lookup above is.
    const freshness = stores().syncState.freshnessFor(people.map((person) => person.id))

    const items: MemberRow[] = people.map((person): MemberRow => {
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
          lastLoginAtMs: account.lastLoginAtMs,
          sync: freshness.get(person.id) ?? null,
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
        // No account and no pending invite is a revoked or expired invite nobody redeemed. The
        // person row still exists, so it stays listed rather than vanishing into a state nothing
        // explains - it just gets its own honest label instead of the still-pending one. Ruling:
        // re-issuing against this row and deleting it are both new surface the spec does not
        // scope here; this state exists to name what the row is, not to offer a way out of it.
        state: invite ? 'invited' : 'expired',
        inviteId: invite?.id ?? null,
        lastLoginAtMs: null,
        sync: null,
      }
    })
    return reply.send({ items })
  })

  /**
   * One field, because the other one was never the admin's to answer.
   *
   * This used to require a timezone as well, and the acceptance screen only read it back: the
   * admin guessed a household member's day boundary on their behalf, the member saw the guess and
   * could not touch it, and nothing anywhere could correct it afterwards. The inviting admin's own
   * zone is the better guess by a distance - a household mostly shares one - and it is now only a
   * starting value, since the member changes it in their own Profile card the moment they are in.
   */
  app.post<{ Body: CreateMemberBody }>('/api/members', { preHandler: guard }, async (request, reply) => {
    const { displayName } = request.body ?? {}
    // trim(), not === '': a name of only spaces is exactly as useless as an empty one, and the
    // household member list is what a person sees named after them - it deserves the same refusal.
    if (typeof displayName !== 'string' || displayName.trim() === '') {
      return reply.code(statusFor('config'))
        .send(errorBody('config', 'config', 'displayName is required'))
    }
    // The caller is an admin with a live session, so both of these resolve; the fallback is for
    // the type rather than for a state this route can be reached in. Read rather than validated:
    // it was validated when it was written, by the wizard or by the owner's own Profile card,
    // which is the only surface that can put a value in this column.
    const inviter = stores().accounts.getById(callerAccountId(request))
    const timezone = (inviter ? stores().people.get(inviter.personId)?.timezone : null) ?? 'UTC'

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

  /**
   * The named exception to "no admin override" (see the accounts table's own comment): an admin
   * may set another member's password, and nothing else of theirs.
   *
   * It exists because this instance has no way to prove a reset request came from the person it
   * names - no mail server, no second factor - so the only proof available is somebody standing in
   * the household who is already trusted with the instance. The console tool in admin.ts is the
   * same door for the case where even that person is locked out; this is it without a shell.
   *
   * No current password is asked for, and there is nothing coherent to ask for: the admin does not
   * know it, which is the entire situation. What that costs is stated plainly rather than hidden -
   * an admin can take over another account here. What it does not cost is data: the member's rows
   * stay reachable only through their own session, and the isolation suites still prove it.
   *
   * The member's own sessions are deliberately left alone. Whoever asked for this reset is
   * standing next to the admin; signing out the device in their hand, and every other one, would
   * be the app deciding their account was stolen on evidence it does not have.
   */
  app.post<{ Params: AccountParams, Body: ResetPasswordBody }>('/api/members/:accountId/password', { preHandler: guard }, async (request, reply) => {
    const { accountId } = request.params
    const account = stores().accounts.getById(accountId)
    if (!account) {
      return reply.code(statusFor('not_found')).send(errorBody('not_found', 'no_such_account', `no account '${accountId}'`))
    }
    const { password } = request.body ?? {}
    if (typeof password !== 'string') {
      return reply.code(statusFor('config')).send(errorBody('config', 'config', 'password is required'))
    }
    try {
      await stores().accounts.setPasswordById(accountId, password)
    } catch (error) {
      // This family has no scope of its own (see the note above registerMemberRoutes), so the one
      // route here that lets core throw catches it itself rather than registering an error handler
      // that would also swallow the four routes beside it.
      return sendCoreError(reply, error)
    }
    // Unlike this member's own sessions (deliberately left alone, see the comment above), their
    // MCP tokens end here. An admin resetting a password without knowing the old one is exactly
    // the "somebody may have this account" situation the whole route exists for, and an agent
    // credential the reset leaves standing would be the one door this recovery path forgot to
    // close.
    stores().mcpTokens.revokeAllForAccount(accountId, app.haelan.now())
    return reply.code(204).send()
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
 * By the time any handler above runs, requireSession has already stopped a missing session with
 * its own 401 and requireAdmin has confirmed the account it resolved is an admin, so
 * request.accountId is a real, admin account here. The decoration itself stays nullable (see
 * auth.ts): it is set once for the whole app, and its type cannot be narrowed to what only this
 * file's preHandler chain guarantees.
 */
function callerAccountId(request: FastifyRequest): string {
  return request.accountId as string
}
