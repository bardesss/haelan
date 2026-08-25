import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { BASELINE_WINDOW_DAYS, ConfigError, PersonQuery } from '@haelan/core'
import type { DailyPoint, SeriesResult } from '@haelan/core'
import { notModified, stampEtag } from '../../api/etag.ts'

interface PersonParams { personId: string }

interface SeriesQuery {
  metric?: string | string[]
  agg?: string
  from?: string
  to?: string
  points?: string
  source?: string
}

interface BaselinesQuery {
  metric?: string
  agg?: string
  on?: string
  windowDays?: string
  source?: string
}

interface InsightsQuery {
  metric?: string
  agg?: string
  from?: string
  to?: string
  source?: string
}

interface TrendQuery {
  metric?: string
  agg?: string
  from?: string
  to?: string
  source?: string
}

/**
 * request.personQuery is decorated null and set by registerV1's preHandler hook, which every
 * route in this file runs behind. Narrowing here rather than asserting with ! keeps the reason
 * the type system carries: the guard, not the route, is what makes this safe.
 */
function personQueryOf(request: FastifyRequest): PersonQuery {
  const personQuery = request.personQuery
  if (personQuery === null) throw new Error('personQuery was not set; the plugin guard did not run')
  return personQuery
}

/** repeated ?metric= comes back as an array; one occurrence comes back as a bare string. */
function metricsFrom(raw: string | string[] | undefined): string[] {
  if (raw === undefined) throw new ConfigError('metric is required')
  return Array.isArray(raw) ? raw : [raw]
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

interface Stamp { newestMs: number | null, rows: number }

/**
 * Folds the points a `daily` backed answer drew on into the pair its ETag is built from: the
 * newest `updated_at_ms` among them, ignoring the ones a row derived before M3b never got, and
 * how many rows there were. The count comes from here rather than a second query, because it is
 * the response's own count that has to move when a row the derivation dropped is no longer in it.
 */
function stampOf(points: readonly DailyPoint[]): Stamp {
  let newestMs: number | null = null
  for (const point of points) {
    if (point.updatedAtMs !== null && (newestMs === null || point.updatedAtMs > newestMs)) newestMs = point.updatedAtMs
  }
  return { newestMs, rows: points.length }
}

/** Folds several stamps into one, for a route whose answer drew on more than one window or metric. */
function combineStamps(stamps: readonly Stamp[]): Stamp {
  let newestMs: number | null = null
  let rows = 0
  for (const stamp of stamps) {
    if (stamp.newestMs !== null && (newestMs === null || stamp.newestMs > newestMs)) newestMs = stamp.newestMs
    rows += stamp.rows
  }
  return { newestMs, rows }
}

/**
 * Steps a calendar local date by whole days, exactly as core's own `shiftLocalDate` does. Not
 * imported, because the barrel does not export it: `baseline` and `comparePeriods` already
 * compute the window their answer drew on, but return only the figures derived from it, not the
 * points themselves, so this route reopens the same window to read the `updatedAtMs` those points
 * carry and PersonQuery's return value does not.
 */
function shiftLocalDate(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** Sets the ETag, then either a 304 with no body or the answer itself, per `notModified`. */
function sendStamped(reply: FastifyReply, request: FastifyRequest, body: unknown, stamp: Stamp) {
  const etag = stampEtag(stamp.newestMs, stamp.rows)
  reply.header('etag', etag)
  if (notModified(request, etag)) return reply.code(304).send()
  return reply.send(body)
}

/**
 * The four `daily` backed reads. Each handler is a parameter check, one core call and a
 * serialiser: no try/catch, because the plugin's setErrorHandler (registerV1) turns whatever
 * PersonQuery throws into the right response.
 */
export function registerSeriesRoutes(app: FastifyInstance): void {
  // Ruling R2: keyed by metric even for one metric, so a client never has to branch on how many
  // it asked for. { [metric]: { points, reduction } }, always.
  app.get<{ Params: PersonParams, Querystring: SeriesQuery }>('/p/:personId/series', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const metrics = metricsFrom(request.query.metric)
    const agg = requireString(request.query.agg, 'agg')
    const from = requireString(request.query.from, 'from')
    const to = requireString(request.query.to, 'to')
    const points = optionalPositiveInt(request.query.points, 'points')
    const source = request.query.source

    const body: Record<string, SeriesResult> = {}
    for (const metric of metrics) {
      body[metric] = personQuery.series({ metric, agg, from, to, points, source })
    }
    // R2's keying means the ETag has to account for every metric asked for, not just the first:
    // a client that added a metric to the same range must not be handed the stale ETag.
    const stamp = combineStamps(metrics.map((metric) => stampOf(body[metric]!.points)))
    return sendStamped(reply, request, body, stamp)
  })

  app.get<{ Params: PersonParams, Querystring: BaselinesQuery }>('/p/:personId/baselines', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const metric = requireString(request.query.metric, 'metric')
    const agg = requireString(request.query.agg, 'agg')
    const on = requireString(request.query.on, 'on')
    const windowDays = optionalPositiveInt(request.query.windowDays, 'windowDays') ?? BASELINE_WINDOW_DAYS
    const source = request.query.source
    const body = personQuery.baseline({ metric, agg, on, windowDays, source })

    // baseline's own window ends the day before `on`, over windowDays. It answers center, spread
    // and n, none of which carries updatedAtMs, so the window is reopened here through the same
    // series() call baseline() made internally, to read the one thing its return value drops.
    const to = shiftLocalDate(on, -1)
    const from = shiftLocalDate(to, -(windowDays - 1))
    const { points } = personQuery.series({ metric, agg, from, to, source })
    return sendStamped(reply, request, body, stampOf(points))
  })

  app.get<{ Params: PersonParams, Querystring: InsightsQuery }>('/p/:personId/insights', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const metric = requireString(request.query.metric, 'metric')
    const agg = requireString(request.query.agg, 'agg')
    const from = requireString(request.query.from, 'from')
    const to = requireString(request.query.to, 'to')
    const source = request.query.source
    const body = personQuery.comparePeriods({ metric, agg, from, to, source })

    // comparePeriods fills currentRange and previousRange in from the arithmetic it already did,
    // so both windows the answer drew on are read straight off the response rather than redoing
    // the "period before this one" math a second time.
    const current = personQuery.series({ metric, agg, from: body.currentRange!.from, to: body.currentRange!.to, source })
    const previous = personQuery.series({ metric, agg, from: body.previousRange!.from, to: body.previousRange!.to, source })
    return sendStamped(reply, request, body, combineStamps([stampOf(current.points), stampOf(previous.points)]))
  })

  app.get<{ Params: PersonParams, Querystring: TrendQuery }>('/p/:personId/trend', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const metric = requireString(request.query.metric, 'metric')
    const agg = requireString(request.query.agg, 'agg')
    const from = requireString(request.query.from, 'from')
    const to = requireString(request.query.to, 'to')
    const source = request.query.source
    const body = personQuery.trend({ metric, agg, from, to, source })

    // trend smooths the same series() this reads again, over the same from/to: no window math to
    // redo here, only the read of updatedAtMs the smoothed points themselves do not carry.
    const { points } = personQuery.series({ metric, agg, from, to, source })
    return sendStamped(reply, request, body, stampOf(points))
  })
}
