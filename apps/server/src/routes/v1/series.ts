import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { BASELINE_WINDOW_DAYS, baselineWindow } from '@haelan/core'
import type { DailyPoint, SeriesResult } from '@haelan/core'
import { notModified, stampEtag } from '../../api/etag.ts'
import type { Stamp } from '../../api/etag.ts'
import { metricsFrom, optionalPositiveInt, personQueryOf, requireBoundedRange, requireString } from './shared.ts'

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

/**
 * Sets the ETag, then either a 304 with no body or the answer itself, per `notModified`.
 *
 * Takes every window the answer drew on rather than one folded stamp: see stampEtag for why the
 * folding cannot be a sum.
 */
function sendStamped(reply: FastifyReply, request: FastifyRequest, body: unknown, windows: readonly Stamp[]) {
  const etag = stampEtag(windows)
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
    const stamps: Stamp[] = []
    for (const metric of metrics) {
      body[metric] = personQuery.series({ metric, agg, from, to, points, source })
      // Stamped from the unthinned window, not the thinned body `points` thins to: batch
      // derivation stamps every row it touches with one shared clock, so after a rebuild a
      // whole history can carry the same updated_at_ms, and thinning always keeps the target
      // count regardless of what changed underneath it. A stamp taken from the thinned rows
      // could then pin both figures while a row thinning did not surface moved. No thinning
      // means the two calls would answer the same rows, so the second is skipped.
      const unthinned = points === undefined ? body[metric]! : personQuery.series({ metric, agg, from, to, source })
      stamps.push(stampOf(unthinned.points))
    }
    // R2's keying means the ETag has to account for every metric asked for, not just the first:
    // a client that added a metric to the same range must not be handed the stale ETag. Each
    // metric folds in as its own pair, so one metric's loss cannot cancel another's gain.
    return sendStamped(reply, request, body, stamps)
  })

  // Wrapped, for the reason R2 keys /series by metric even for one: a response whose top level
  // shape changes is one every client has to branch on. Answering null when there is no history
  // is right, but a bare null with status 200 is a second shape, so it becomes
  // { baseline: null } and the key is always there.
  app.get<{ Params: PersonParams, Querystring: BaselinesQuery }>('/p/:personId/baselines', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const metric = requireString(request.query.metric, 'metric')
    const agg = requireString(request.query.agg, 'agg')
    const on = requireString(request.query.on, 'on')
    const windowDays = optionalPositiveInt(request.query.windowDays, 'windowDays') ?? BASELINE_WINDOW_DAYS
    const source = request.query.source
    const baseline = personQuery.baseline({ metric, agg, on, windowDays, source })

    // baseline() answers center, spread and n, none of which carries updatedAtMs, so its own
    // window (the same rule baselineWindow names, which baseline() now calls too) is reopened
    // here through a fresh series() call, to read the one thing baseline()'s return value drops.
    const { from, to } = baselineWindow(on, windowDays)
    const { points } = personQuery.series({ metric, agg, from, to, source })
    return sendStamped(reply, request, { baseline }, [stampOf(points)])
  })

  app.get<{ Params: PersonParams, Querystring: InsightsQuery }>('/p/:personId/insights', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const metric = requireString(request.query.metric, 'metric')
    const agg = requireString(request.query.agg, 'agg')
    const from = requireString(request.query.from, 'from')
    const to = requireString(request.query.to, 'to')
    // Bounded like /trend and /sleep/nights. The review assumed this route already refused a very
    // wide range as a side effect of the comparison window arithmetic. It did not: a two century
    // range answered 200. Stated as a limit here rather than left to arithmetic to imply.
    requireBoundedRange(from, to)
    const source = request.query.source
    const body = personQuery.comparePeriods({ metric, agg, from, to, source })

    // comparePeriods fills currentRange and previousRange in from the arithmetic it already did,
    // so both windows the answer drew on are read straight off the response rather than redoing
    // the "period before this one" math a second time.
    const current = personQuery.series({ metric, agg, from: body.currentRange!.from, to: body.currentRange!.to, source })
    const previous = personQuery.series({ metric, agg, from: body.previousRange!.from, to: body.previousRange!.to, source })
    return sendStamped(reply, request, body, [stampOf(current.points), stampOf(previous.points)])
  })

  app.get<{ Params: PersonParams, Querystring: TrendQuery }>('/p/:personId/trend', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const metric = requireString(request.query.metric, 'metric')
    const agg = requireString(request.query.agg, 'agg')
    const from = requireString(request.query.from, 'from')
    const to = requireString(request.query.to, 'to')
    requireBoundedRange(from, to)
    const source = request.query.source
    // Wrapped in an object rather than answered as a bare top level array, so this route's shape
    // matches the rest of the surface: a client reads body.points here the same way it reads
    // body[metric].points on /series, instead of branching on whether the body is an array.
    const smoothed = personQuery.trend({ metric, agg, from, to, source })

    // trend smooths the same series() this reads again, over the same from/to: no window math to
    // redo here, only the read of updatedAtMs the smoothed points themselves do not carry.
    const { points } = personQuery.series({ metric, agg, from, to, source })
    return sendStamped(reply, request, { points: smoothed }, [stampOf(points)])
  })
}
