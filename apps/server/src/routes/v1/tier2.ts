import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConfigError, PersonQuery } from '@haelan/core'
import type { IntradayResult, Night, WorkoutSession } from '@haelan/core'
import { requireBoundedRange, sendHashed } from './shared.ts'

interface PersonParams { personId: string }

interface IntradayQuery {
  metric?: string
  date?: string
  points?: string
  source?: string
}

interface NightsQuery {
  from?: string
  to?: string
  limit?: string
  cursor?: string
  source?: string
}

interface SessionsQuery {
  kind?: string
  from?: string
  to?: string
  limit?: string
  cursor?: string
  source?: string
}

/**
 * request.personQuery is decorated null and set by registerV1's preHandler hook, which every
 * route in this file runs behind. Narrowing here rather than asserting with ! keeps the reason
 * the type system carries: the guard, not the route, is what makes this safe. Matches the pattern
 * series.ts already established.
 */
function personQueryOf(request: FastifyRequest): PersonQuery {
  const personQuery = request.personQuery
  if (personQuery === null) throw new Error('personQuery was not set; the plugin guard did not run')
  return personQuery
}

function requireString(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new ConfigError(`${name} is required`)
  return value
}

function optionalPositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer, got '${value}'`)
  return n
}

/**
 * The cursor is opaque to the caller: a base64 encoding of whatever key locates a row in the
 * list's own total order, never an offset. A row inserted ahead of the cursor between two calls
 * cannot shift an offset based page and repeat or skip a row; a key based one is immune to that
 * because it names the row itself, not a position in a list that can change under it.
 */
function encodeCursor(key: unknown): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new ConfigError(`cursor is not valid, got '${raw}'`)
  }
}

/**
 * Slices a page out of a list that already carries a total order. M3b-1's readers guarantee one
 * for both Night (localDate, sourceId) and WorkoutSession (startMs, id), so this never has to
 * invent an ordering of its own, only walk the one already there.
 */
function paginate<T>(items: readonly T[], input: {
  limit?: number
  cursor?: string
  keyOf: (item: T) => unknown
}): { items: T[], cursor: string | null } {
  let start = 0
  if (input.cursor !== undefined) {
    const key = JSON.stringify(decodeCursor(input.cursor))
    const index = items.findIndex((item) => JSON.stringify(input.keyOf(item)) === key)
    if (index === -1) throw new ConfigError('cursor does not match any row in range')
    start = index + 1
  }
  const rest = items.slice(start)
  const page = input.limit === undefined ? rest : rest.slice(0, input.limit)
  const hasMore = start + page.length < items.length
  const last = page.at(-1)
  const cursor = hasMore && last !== undefined ? encodeCursor(input.keyOf(last)) : null
  return { items: page, cursor }
}

/**
 * The three tier 2 reads: intraday samples, sleep nights and workout sessions, each backed by the
 * normalized tier rather than the merged `daily` rollup. Each takes `source`: M3b-1's readers
 * never choose between sources themselves, since this project already has exactly one source
 * selection policy, the priority list the derive layer applies when writing merged `daily` rows.
 * A caller that passes no source gets every device's data, correctly labelled; one that passes
 * one gets that device's. See personQuery.ts, readSleepNights and readSessions for the reasoning
 * this route must not undo by merging, deduplicating or picking a winner on the way out.
 *
 * Each handler stays a parameter check, one core call and a serialiser: no try/catch, because
 * registerV1's setErrorHandler turns whatever PersonQuery throws into the right response.
 */
export function registerTier2Routes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams, Querystring: IntradayQuery }>('/p/:personId/intraday', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const metric = requireString(request.query.metric, 'metric')
    const date = requireString(request.query.date, 'date')
    const points = optionalPositiveInt(request.query.points, 'points')
    const source = request.query.source

    const result: IntradayResult = personQuery.intraday({ metric, localDate: date, points, sourceId: source })
    return sendHashed(reply, request, result)
  })

  app.get<{ Params: PersonParams, Querystring: NightsQuery }>('/p/:personId/sleep/nights', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const from = requireString(request.query.from, 'from')
    const to = requireString(request.query.to, 'to')
    requireBoundedRange(from, to)
    const limit = optionalPositiveInt(request.query.limit, 'limit')
    const source = request.query.source

    const nights: Night[] = personQuery.sleepNights({ from, to, sourceId: source })
    const page = paginate(nights, {
      limit, cursor: request.query.cursor, keyOf: (n) => [n.localDate, n.sourceId],
    })
    return sendHashed(reply, request, page)
  })

  app.get<{ Params: PersonParams, Querystring: SessionsQuery }>('/p/:personId/sessions', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const kind = requireString(request.query.kind, 'kind')
    const from = requireString(request.query.from, 'from')
    const to = requireString(request.query.to, 'to')
    const limit = optionalPositiveInt(request.query.limit, 'limit')
    const source = request.query.source

    const kindChecked = kind as 'sleep' | 'exercise' // requireSessionKind validates this at runtime, inside the core call below
    const all: WorkoutSession[] = personQuery.sessions({ kind: kindChecked, from, to, sourceId: source })
    const page = paginate(all, { limit, cursor: request.query.cursor, keyOf: (s) => s.id })
    return sendHashed(reply, request, page)
  })
}
