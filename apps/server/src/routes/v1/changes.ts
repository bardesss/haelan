import type { FastifyInstance } from 'fastify'
import { ConfigError } from '@haelan/core'
import type { ChangesResult } from '@haelan/core'
import { personQueryOf, sendHashed } from './shared.ts'

interface PersonParams { personId: string }

interface ChangesQuery {
  since?: string
  limit?: string
  cursor?: string
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
 * A parameter check, one core call and the shared ETag serialiser: PersonQuery.changes already
 * answers the paged shape. No try/catch, because registerV1's setErrorHandler turns whatever it
 * throws into the right response.
 *
 * The ETag matters more here than anywhere else on this surface: this route exists to be polled,
 * so without one a client re-downloads a body it already has on every interval, and the common
 * answer to "what changed" is the empty page it saw last time.
 */
export function registerChangesRoutes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams, Querystring: ChangesQuery }>('/p/:personId/changes', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const since = requireNumber(request.query.since, 'since')
    const limit = optionalPositiveInt(request.query.limit, 'limit')
    const cursor = request.query.cursor

    const result: ChangesResult = personQuery.changes({ since, limit, cursor })
    return sendHashed(reply, request, result)
  })
}
