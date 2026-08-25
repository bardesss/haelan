import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConfigError, PersonQuery } from '@haelan/core'
import type { ChangesResult } from '@haelan/core'

interface PersonParams { personId: string }

interface ChangesQuery {
  since?: string
  limit?: string
  cursor?: string
}

/**
 * request.personQuery is decorated null and set by registerV1's preHandler hook, which every
 * route in this file runs behind. Narrowing here rather than asserting with ! keeps the reason
 * the type system carries: the guard, not the route, is what makes this safe. Matches the pattern
 * series.ts and tier2.ts already established.
 */
function personQueryOf(request: FastifyRequest): PersonQuery {
  const personQuery = request.personQuery
  if (personQuery === null) throw new Error('personQuery was not set; the plugin guard did not run')
  return personQuery
}

function requireNumber(value: string | undefined, name: string): number {
  if (value === undefined || value === '') throw new ConfigError(`${name} is required`)
  const n = Number(value)
  if (!Number.isFinite(n)) throw new ConfigError(`${name} must be a number, got '${value}'`)
  return n
}

function optionalPositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer, got '${value}'`)
  return n
}

/**
 * The (localDate, metric) pairs that moved since a moment: the other half of what updated_at_ms
 * exists for, a client refetching the days that changed rather than its whole history.
 *
 * A parameter check, one core call, no serialiser step of its own: PersonQuery.changes already
 * answers the paged shape. No try/catch, because registerV1's setErrorHandler turns whatever it
 * throws into the right response.
 */
export function registerChangesRoutes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams, Querystring: ChangesQuery }>('/p/:personId/changes', async (request) => {
    const personQuery = personQueryOf(request)
    const since = requireNumber(request.query.since, 'since')
    const limit = optionalPositiveInt(request.query.limit, 'limit')
    const cursor = request.query.cursor

    const result: ChangesResult = personQuery.changes({ since, limit, cursor })
    return result
  })
}
