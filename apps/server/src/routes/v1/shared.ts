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

/**
 * Ten years, inclusive of both ends. Generous on purpose: the widest view a real dashboard offers
 * is "all time", and a self hosted instance holding a decade of imported wearable history is
 * already at the far end of what anyone actually has. The point of the number is only that it is
 * finite. Without it, one authenticated GET with from=1000-01-01&to=9999-12-31 made /trend
 * materialise 3.28 million day entries against an empty database, holding the event loop for
 * roughly twelve seconds and ~290MB of heap, with no body and no data required.
 */
export const MAX_RANGE_DAYS = 3660

const DAY_MS = 86_400_000

/**
 * Refuses a range wider than the ceiling, for the reads whose cost is a function of the range
 * asked for rather than of the rows that exist: /trend builds one array entry per day regardless
 * of data, and /sleep/nights pulls every session row in range into JS before paginate slices it.
 * The `daily` backed reads are bounded by SQL and by the rows actually present, so they do not
 * need this.
 *
 * A malformed or reversed range is left to the core call underneath, whose message names which
 * date is wrong; this only refuses a well formed range that is merely too wide, and the message
 * names the limit so a caller knows what to ask for instead.
 */
export function requireBoundedRange(from: string, to: string, name = 'range'): void {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
  if (!Number.isFinite(days)) return
  if (days > MAX_RANGE_DAYS) {
    throw new ConfigError(
      `${name} '${from}'..'${to}' spans ${days} days, more than the ${MAX_RANGE_DAYS} day maximum`,
    )
  }
}
