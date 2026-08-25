import type { FastifyRequest } from 'fastify'
import { ConfigError, PersonQuery } from '@haelan/core'

/**
 * request.personQuery is decorated null and set by registerV1's preHandler hook, which every
 * route in this plugin runs behind. Narrowing here rather than asserting with ! keeps the reason
 * the type system carries: the guard, not the route, is what makes this safe. Shared rather than
 * copied per file, since series.ts and export.ts both need exactly this and a bug fixed in one
 * copy must not be able to survive in the other.
 */
export function personQueryOf(request: FastifyRequest): PersonQuery {
  const personQuery = request.personQuery
  if (personQuery === null) throw new Error('personQuery was not set; the plugin guard did not run')
  return personQuery
}

export function requireString(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new ConfigError(`${name} is required`)
  return value
}

/** repeated ?metric= comes back as an array; one occurrence comes back as a bare string. */
export function metricsFrom(raw: string | string[] | undefined): string[] {
  if (raw === undefined) throw new ConfigError('metric is required')
  return Array.isArray(raw) ? raw : [raw]
}
