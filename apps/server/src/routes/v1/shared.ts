import type { FastifyReply, FastifyRequest } from 'fastify'
import { ConfigError, metricSpec, PersonQuery } from '@haelan/core'
import type { SeriesResult } from '@haelan/core'
import { hashEtag, notModified } from '../../api/etag.ts'

/**
 * request.personQuery is decorated null and set by registerV1's preHandler hook, which every
 * route in this plugin runs behind. Narrowing here rather than asserting with ! keeps the reason
 * the type system carries: the guard, not the route, is what makes this safe. Shared rather than
 * copied per file, since every route file in this directory needs exactly this and a bug fixed in
 * one copy must not be able to survive in the other.
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

/**
 * A query string carries text, never numbers, so `points`, `limit` and `windowDays` all arrive
 * here as strings and all three have to refuse the same set of values. Shared for the reason this
 * file exists: three byte identical copies of this lived in series.ts, tier2.ts and changes.ts,
 * and the refusal a caller sees for a bad `limit` must not be able to drift from the one they see
 * for a bad `points`.
 */
export function optionalPositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer, got '${value}'`)
  return n
}

/**
 * repeated ?metric= comes back as an array; one occurrence comes back as a bare string.
 *
 * Deduplicated in request order. Asking for the same metric twice is a client bug rather than a
 * request worth refusing, but carrying the duplicate through meant /export wrote every data row
 * into the CSV twice and named the file haelan-steps-steps-..., and /series counted the same rows
 * twice into its ETag, so a body byte identical to one stamped W/"v1.1000-1" came back as W/"v1.1000-2".
 */
export function metricsFrom(raw: string | string[] | undefined): string[] {
  if (raw === undefined) throw new ConfigError('metric is required')
  return Array.isArray(raw) ? [...new Set(raw)] : [raw]
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

/**
 * Sets the ETag, then either a 304 with no body or the answer itself.
 *
 * The content hash base rather than the stamp plus count one, for the routes whose answer has no
 * `updated_at_ms` pair that describes it: `samples`, `sessions` and `session_segments` carry no
 * such column at all, /export's body is a serialisation the row stamps do not determine, and
 * /changes is a page cut out of a keyset walk whose contents move independently of any one row's
 * stamp. Called on the assembled body, after any thinning or pagination, so two responses that
 * differ in what the caller actually receives can never share an ETag.
 */
export function sendHashed(reply: FastifyReply, request: FastifyRequest, body: unknown) {
  const etag = hashEtag(body)
  reply.header('etag', etag)
  if (notModified(request, etag)) return reply.code(304).send()
  return reply.send(body)
}

/**
 * Rounds a value already expressed in a metric's own stored unit (MetricSpec.precision's own doc
 * comment: "in the unit this spec declares") to that many decimals. Called only here, at the HTTP
 * response boundary, and never by anything that writes a row: `daily` and `samples` keep full
 * precision regardless, the same as before this function existed, because moving a rounding step
 * into derivation would move DERIVATION_VERSION and force every person's history to rebuild for a
 * change that is about how a number is shown, not what it is.
 *
 * An unknown metric has no declared precision to round to, and passes its value through unchanged
 * rather than falling back to a guessed decimal count, which would silently truncate a reading
 * nobody declared a precision for. Every /series, /export, /trend, /insights and /intraday caller
 * here has already had its metric checked by `requireMetricAndAgg` or `requireMetric` inside
 * PersonQuery, so for those this branch is a safety net rather than a path a real request takes.
 * annotations.ts's /overrides caller is the one exception: its metric comes from
 * `parseSampleTarget` on a stored `target_key`, which never touches PersonQuery, and neither that
 * parser nor OverrideStore.validate checks it against METRICS. A `POST /overrides` naming a
 * metric the catalogue has never heard of writes successfully and reaches this branch on the very
 * next `GET /overrides`, which is why it is tested directly (v1-precision.test.ts).
 */
export function roundMetricValue(metric: string, value: number): number {
  const precision = metricSpec(metric)?.precision
  return precision === undefined ? value : Number(value.toFixed(precision))
}

export function roundMetricValueOrNull(metric: string, value: number | null): number | null {
  return value === null ? null : roundMetricValue(metric, value)
}

/**
 * Rounds every point's value in a SeriesResult to its own metric's catalogue precision. Shared by
 * /series and /export, which serialise the same shape, so the two cannot drift into rounding the
 * same figure two different ways (v1-export.test.ts holds them to an identical body already).
 *
 * Applied after thinning, never before: thin() inside PersonQuery.series picks which points
 * survive by their real, unrounded shape (downsample.ts's lttb reads point.value directly), so
 * which points a caller sees must not depend on how many decimals they are eventually shown with.
 */
export function roundSeriesResult(metric: string, result: SeriesResult): SeriesResult {
  return {
    ...result,
    points: result.points.map((point) => ({ ...point, value: roundMetricValue(metric, point.value) })),
  }
}
