import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { BASELINE_WINDOW_DAYS, baselineWindow } from '@haelan/core'
import type { DailyPoint, SeriesResult } from '@haelan/core'
import { notModified, stampEtag } from '../../api/etag.ts'
import type { Stamp } from '../../api/etag.ts'
import {
  metricsFrom, optionalPositiveInt, personQueryOf, requireBoundedRange, requireString,
  roundMetricValue, roundMetricValueOrNull, roundSeriesResult,
} from './shared.ts'

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
      const result = personQuery.series({ metric, agg, from, to, points, source })
      // Stamped from the unthinned window, not the thinned body `points` thins to: batch
      // derivation stamps every row it touches with one shared clock, so after a rebuild a
      // whole history can carry the same updated_at_ms, and thinning always keeps the target
      // count regardless of what changed underneath it. A stamp taken from the thinned rows
      // could then pin both figures while a row thinning did not surface moved. No thinning
      // means the two calls would answer the same rows, so the second is skipped.
      const unthinned = points === undefined ? result : personQuery.series({ metric, agg, from, to, source })
      stamps.push(stampOf(unthinned.points))
      // Rounded last, after the stamp is taken: the ETag above is a function of which rows and
      // how many, never of their values, so rounding afterward cannot move it. See
      // roundSeriesResult for why this has to happen after thinning too.
      body[metric] = roundSeriesResult(metric, result)
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
    // Deliberately not rounded, unlike every other body in this file. center and spread are not
    // themselves a number a reader ever sees: Recovery.tsx and Sleep.tsx both compute
    // `low = center - spread` and `high = center + spread` from these exact fields before their
    // own formatMetricValue call rounds the result to this same metric's precision (see either
    // file's baselineNote/bandFrom, and formatMetricValue's own comment on why that arithmetic
    // needs the metric's raw, un-rounded values to begin with). Rounding center and spread here
    // independently would make that subtraction the difference of two already-rounded numbers
    // rather than of the real ones, which can move the displayed band edge by a whole unit of
    // precision from what the same arithmetic gives today on the raw values. Every number that
    // does reach a reader from this response still passes through that client-side formatter
    // regardless of what this sends, so rounding here would buy no reader anything and risks
    // making the one thing this endpoint feeds, the baseline band, wrong.
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
    const insight = personQuery.comparePeriods({ metric, agg, from, to, source })

    // comparePeriods fills currentRange and previousRange in from the arithmetic it already did,
    // so both windows the answer drew on are read straight off the response rather than redoing
    // the "period before this one" math a second time.
    const currentWindow = personQuery.series({ metric, agg, from: insight.currentRange!.from, to: insight.currentRange!.to, source })
    const previousWindow = personQuery.series({ metric, agg, from: insight.previousRange!.from, to: insight.previousRange!.to, source })
    // current and previous round to the metric's own catalogue precision, same as a /series point
    // would. delta is deliberately NOT insight.delta rounded on its own: comparePeriods computed
    // that from the stored, unrounded figures, and rounding it independently produced a response
    // where a reader's own arithmetic on the two numbers in front of them (70 minus 61) disagreed
    // with the delta printed beside them (10, not 9), because the raw difference crosses a
    // rounding boundary the two rounded ends do not. delta here is current-after-rounding minus
    // previous-after-rounding instead, run back through the same rounding step only to settle the
    // float noise a subtraction of two decimals can reintroduce, so the three numbers this
    // response carries always agree with each other the way they would if a reader worked it out
    // by hand from what they were shown.
    const current = roundMetricValueOrNull(metric, insight.current)
    const previous = roundMetricValueOrNull(metric, insight.previous)
    const delta = current === null || previous === null ? null : roundMetricValue(metric, current - previous)
    const body = { ...insight, current, previous, delta }
    return sendStamped(reply, request, body, [stampOf(currentWindow.points), stampOf(previousWindow.points)])
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
    //
    // Rounded to the metric's own precision the same way a /series point is: a smoothed line is
    // still a reading of this metric, in its own unit, and a reader looking at a trend chart's
    // accessible table deserves the same rounded figure /series would give them for the same day.
    const smoothed = personQuery.trend({ metric, agg, from, to, source })
      .map((point) => ({ ...point, value: roundMetricValue(metric, point.value) }))

    // trend smooths the same series() this reads again, over the same from/to: no window math to
    // redo here, only the read of updatedAtMs the smoothed points themselves do not carry.
    const { points } = personQuery.series({ metric, agg, from, to, source })
    return sendStamped(reply, request, { points: smoothed }, [stampOf(points)])
  })
}
