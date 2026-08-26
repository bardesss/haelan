import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PersonQuery } from '@haelan/core'
import { errorBody, statusFor } from './envelope.ts'

declare module 'fastify' {
  interface FastifyRequest { personQuery: PersonQuery | null }
  interface FastifyInstance {
    requirePerson: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

/**
 * Two checks, and both stay. This is the guard registerV1 runs in front of every route in its
 * plugin scope; PersonQuery's constructor binding, below, is the guard a forgotten WHERE clause
 * cannot get around.
 *
 * accounts.person_id is unique and not null, so :personId is always the session's own today.
 * The segment stays anyway: a later milestone's bearer tokens bind to a person rather than an
 * account, and a redundant segment that is checked is what makes the isolation suite test
 * something rather than assert a tautology.
 */
export function registerRequirePerson(app: FastifyInstance): void {
  // Matches how accountId is decorated in auth.ts: nullable, because the guarantee the type
  // makes is only as strong as this decoration, not as strong as the comment above it. A plain
  // assignment with no decorateRequest would let the type claim non-null while nothing enforced it.
  app.decorateRequest('personQuery', null)

  app.decorate('requirePerson', async (request: FastifyRequest, reply: FastifyReply) => {
    // registerV1's plugin-wide hook always runs requireSession first and stops on its own 401
    // before this runs. The check stays here too rather than trusting the caller's wiring, since
    // a hook built differently, or a route reached some other way, would otherwise read
    // request.accountId as null and crash on the store lookup below.
    const accountId = request.accountId
    if (!accountId) {
      return reply.code(statusFor('unauthorized')).send(errorBody('unauthorized', 'no_session', 'sign in required'))
    }
    const account = app.haelan.stores.accounts.getById(accountId)
    if (!account) {
      return reply.code(statusFor('unauthorized')).send(errorBody('unauthorized', 'no_session', 'sign in required'))
    }

    const { personId } = request.params as { personId?: string }
    if (typeof personId !== 'string' || personId === '') {
      return reply.code(statusFor('not_found')).send(errorBody('not_found', 'no_such_person', 'no person id in the path'))
    }

    // Not a person at all, and not the caller's person, are different answers: a caller
    // debugging a URL needs to tell a typo apart from someone else's data.
    const person = app.haelan.stores.people.get(personId)
    if (!person) {
      return reply.code(statusFor('not_found')).send(errorBody('not_found', 'no_such_person', `no person '${personId}'`))
    }
    if (account.personId !== personId) {
      return reply.code(statusFor('forbidden')).send(errorBody('forbidden', 'not_your_person', 'this person is not yours'))
    }

    request.personQuery = new PersonQuery(app.haelan.instance.db, account.personId)
  })
}
