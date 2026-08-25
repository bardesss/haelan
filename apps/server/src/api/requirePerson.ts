import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PersonQuery } from '@haelan/core'
import { errorBody, statusFor } from './envelope.ts'

declare module 'fastify' {
  interface FastifyRequest { personQuery: PersonQuery }
  interface FastifyInstance {
    requirePerson: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

/**
 * Two checks, and both stay. This is the guard a reader can see in the route definition;
 * PersonQuery's constructor binding, below, is the guard a forgotten WHERE clause cannot get
 * around.
 *
 * accounts.person_id is unique and not null, so :personId is always the session's own today.
 * The segment stays anyway: a later milestone's bearer tokens bind to a person rather than an
 * account, and a redundant segment that is checked is what makes the isolation suite test
 * something rather than assert a tautology.
 */
export function registerRequirePerson(app: FastifyInstance): void {
  app.decorate('requirePerson', async (request: FastifyRequest, reply: FastifyReply) => {
    // requireSession runs first in every route's preHandler list and already answers 401 for a
    // missing or invalid session, stopping the chain before this runs. The check stays here too
    // rather than trusting the ordering, since a route that lists requirePerson alone would
    // otherwise read request.accountId as null and crash on the store lookup below.
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
