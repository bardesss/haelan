import type { FastifyInstance } from 'fastify'
import { ConfigError } from '@haelan/core'
import type { IntradayResult, Night, WorkoutSession } from '@haelan/core'
import { errorBody, statusFor } from '../../api/envelope.ts'
import {
  optionalPositiveInt, personQueryOf, requireBoundedRange, requireMs, requireString, roundMetricValueOrNull,
  sendHashed,
} from './shared.ts'

interface PersonParams { personId: string }
interface SessionParams { personId: string, sessionId: string }

interface IntradayQuery {
  metric?: string
  date?: string
  points?: string
  source?: string
}

interface IntradayWindowQuery {
  metric?: string
  startMs?: string
  endMs?: string
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
  type?: string
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
 * One exception, made in core rather than here: exercise sessions with no source named answer one
 * workout per event (query/mergedWorkouts.ts), grouped by the same priority list and overlap ratio
 * `workout_count` is derived with, so the list and the count agree. It is still not this route's
 * choice - personQuery.sessions and sessionById make it, and the MCP tools read the same answer.
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
    // Rounded here, at the boundary, not inside readIntraday: min/mean/max are stored and thinned
    // at full precision (thinBand picks its band edges from the real values), so only the reply
    // decides how many decimals a reader of this one metric's chart ends up seeing.
    const rounded: IntradayResult = {
      ...result,
      points: result.points.map((point) => ({
        ...point,
        min: roundMetricValueOrNull(metric, point.min),
        mean: roundMetricValueOrNull(metric, point.mean),
        max: roundMetricValueOrNull(metric, point.max),
      })),
    }
    return sendHashed(reply, request, rounded)
  })

  /**
   * Intraday samples across a UTC window rather than a local date.
   *
   * Its own route rather than optional parameters on /intraday: a night runs 23:15 to 07:02 and
   * spans two local dates, so the two reads answer different questions and one handler taking
   * either would have to branch on which parameters arrived and refuse the combinations that
   * mean nothing.
   */
  app.get<{ Params: PersonParams, Querystring: IntradayWindowQuery }>('/p/:personId/intraday/window', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const metric = requireString(request.query.metric, 'metric')
    const startMs = requireMs(request.query.startMs, 'startMs')
    const endMs = requireMs(request.query.endMs, 'endMs')
    const points = optionalPositiveInt(request.query.points, 'points')
    const source = request.query.source

    const result: IntradayResult = personQuery.intradayWindow({ metric, startMs, endMs, points, sourceId: source })
    // Rounded here, at the boundary, for the same reason the day route rounds here: min/mean/max
    // are stored and thinned at full precision, because thinBand picks its band edges from the
    // real values, so only the reply decides how many decimals a reader ends up seeing.
    const rounded: IntradayResult = {
      ...result,
      points: result.points.map((point) => ({
        ...point,
        min: roundMetricValueOrNull(metric, point.min),
        mean: roundMetricValueOrNull(metric, point.mean),
        max: roundMetricValueOrNull(metric, point.max),
      })),
    }
    return sendHashed(reply, request, rounded)
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
    const type = request.query.type

    // SESSION_KINDS (personQuery's own runtime validator) now also allows 'ecg', a kind this
    // route does not serve: WorkoutSession's attrs carries no ECG classification and nothing has
    // designed what an ECG list response should look like yet. Checked here, ahead of the call
    // below, so kind=ecg is refused with a clear error rather than silently taking the
    // 'sleep' | 'exercise' branch a bare `as` cast used to assert into existence - the cast could
    // no longer back that claim once SESSION_KINDS widened, and nothing would have caught it.
    if (kind !== 'sleep' && kind !== 'exercise') {
      throw new ConfigError(`kind must be one of sleep, exercise, got '${kind}'`)
    }
    // type is passed straight through, unvalidated here: personQuery.sessions already checks it
    // against EXERCISE_TYPES and refuses it alongside kind 'sleep', both as ConfigError, which the
    // shared envelope maps to 400 the same way this route's own checks do. A second check here
    // would just be a second guard for the same rule, free to drift from the first.
    //
    // `latest` is not exposed: a caller wanting one session should say so with `limit=1` against
    // this same list rather than gain a second, narrower parameter to keep in sync with it.
    const all: WorkoutSession[] = personQuery.sessions({ kind, from, to, sourceId: source, type })
    const page = paginate(all, { limit, cursor: request.query.cursor, keyOf: (s) => s.id })
    return sendHashed(reply, request, page)
  })

  /**
   * One session by id, registered next to the list route because the two are the same resource in
   * two shapes. There is no routing conflict between them to resolve: `/sessions` and
   * `/sessions/:sessionId` are at different depths, so fastify never has to choose.
   *
   * Answers the session object directly rather than a one-item list, because a detail read has
   * exactly one answer and wrapping it would make every caller index into it first.
   *
   * `kind` is not a parameter here and cannot be one: an id names its own row. The list route
   * above refuses `kind=ecg`, and readSession refuses an ECG row for the same reason, by
   * answering null - so an ECG id 404s here exactly as an unknown id does.
   */
  app.get<{ Params: SessionParams }>('/p/:personId/sessions/:sessionId', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const sessionId = request.params.sessionId

    // A merged workout for an exercise id, including an id naming a copy that was merged into
    // another: the answer's own `id` is then the primary's, not the one in the path. Answered in
    // place rather than redirected, so a link made before the merge keeps working with no second
    // round trip, and everything joined below is read for the merged workout rather than the copy.
    const session: WorkoutSession | null = personQuery.sessionById({ sessionId })
    // 404 for an id that names nothing and for one belonging to somebody else alike. readSession
    // is scoped by person, so this handler never learns which of the two it is, and therefore
    // cannot leak the difference: a 403 would confirm the id exists.
    if (session === null) {
      return reply.code(statusFor('not_found'))
        .send(errorBody('not_found', 'no_such_session', `no session '${sessionId}'`))
    }
    // Beside the session rather than folded into it: `WorkoutSession` is also what the list route
    // above answers, and a load computed per row there would open a heart rate trace for every
    // session in a range. The detail read has exactly one session and can afford exactly one.
    // workoutSplits carries the same reasoning - a per-row fill on the list route would open a
    // heart rate trace for every session in a date range - so it stays here beside cardioLoad,
    // never on /sessions. route joins them for the same reason and is the heaviest of the three:
    // every recorded point of a run is far more than a handful of splits, so a per-row fill on
    // the list route would be the worst version of this mistake, not a milder one.
    return sendHashed(reply, request, {
      ...session,
      cardioLoad: personQuery.cardioLoad({ sessionId }),
      // Never null here: `session` above already resolved this exact id, and workoutSplits cannot
      // answer null for an id sessionById just answered a row for.
      ...personQuery.workoutSplits({ sessionId })!,
      // Same non-null reasoning: workoutRoute only answers null for an id sessionById would have
      // already refused, and this id was just resolved to a row by it.
      //
      // Coordinates included, on purpose and unlike every MCP tool this instance answers: this
      // route is the household reading their own session, and an export that gave them less than
      // they own would be wrong. get_workout and sql_query keep a route's points out for a reader
      // that was never the household - workoutRoute's own module comment names that boundary and
      // says it lives in the tool catalogue, not here.
      route: personQuery.workoutRoute({ sessionId })!,
    })
  })
}
