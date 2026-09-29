import type { FastifyReply, FastifyRequest } from 'fastify'
import { ConfigError, FIGURE_METRIC_ALIAS, figureDirection, judge, metricSpec, PersonQuery, requireDate, standingOf } from '@haelan/core'
import type { GlanceBaseline, GlanceFigure, GlanceStanding, PageFigure, SeriesResult, WorkoutFigure } from '@haelan/core'
import { hashEtag, notModified } from '../../api/etag.ts'

interface PersonParams { personId: string }
interface DateRangeQuery { from?: string, to?: string }

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
 * A required query parameter that must be a whole number of milliseconds.
 *
 * Separate from optionalPositiveInt: a millisecond instant is required rather than optional, and
 * is not constrained to be positive, since an instant before 1970 is a perfectly well formed one
 * even if no health data carries it.
 */
export function requireMs(value: string | undefined, name: string): number {
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`${name} is required`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigError(`${name} must be a whole number of milliseconds, got '${value}'`)
  }
  return parsed
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

/**
 * The catalogue metric a figure is rounded as, for the figures whose own metric is not a
 * catalogue id: core's FIGURE_METRIC_ALIAS, the same map pageFigureOf judges by, so a figure is
 * never judged as one metric and rounded as another. The recovery index is absent on purpose: it
 * is already an integer, and roundMetricValue passes a metric the catalogue does not know through
 * unchanged, so it needs no entry and no second rounding rule.
 */
export const ROUNDED_AS: Readonly<Record<string, string>> = FIGURE_METRIC_ALIAS

/** Rounds a band's three numbers to `metric`'s catalogue precision: a figure's own band, each strip day's, and each calendar day's alike. */
export function roundBand(metric: string, band: GlanceBaseline | null): GlanceBaseline | null {
  return band === null ? null : {
    ...band,
    center: roundMetricValue(metric, band.center),
    low: roundMetricValue(metric, band.low),
    high: roundMetricValue(metric, band.high),
  }
}

/**
 * Moved here from glance.ts (M10a) so the night page can round its recovery figures by the same
 * rule the glance does.
 *
 * A figure's value, band and strip, each to its metric's catalogue precision, with every verdict
 * recomputed from those same rounded numbers (Task 19a): `standingOf` runs on unrounded values in
 * core, so a value that only clears its baseline's high before rounding (or only after) would
 * otherwise disagree with the band a reader is actually shown, e.g. "60 bpm, above your usual
 * 52 - 60". One rule (`standingOf`), reapplied here at the wire's own precision; core's callers
 * (MCP and others) keep the unrounded figure, so their own comparisons stay internally consistent.
 * `judged` is re-read from each recomputed standing by the metric's direction, so a dot's colour
 * and the verdict words beside it rest on the same rounded pair.
 */
export function roundFigure(figure: GlanceFigure): GlanceFigure {
  const metric = ROUNDED_AS[figure.metric] ?? figure.metric
  const direction = figureDirection(figure.metric)
  const band = roundBand(metric, figure.baseline)
  const value = roundMetricValueOrNull(metric, figure.value)
  const standing = standingOf(value, band, figure.partial)
  // The figure's own day is always the strip's last entry (stripDates ends on `on`); `partial`
  // never applies to an earlier, already-finished day in the same strip (glance.ts's stripOf).
  const ownDate = figure.strip.at(-1)?.localDate ?? null
  return {
    ...figure,
    value,
    baseline: band,
    // Each strip day against its own day's band (glance.ts's stripOf), rounded by the same rule as
    // the figure's: the last day's band is the figure's own, so its dot and the headline agree, and
    // every earlier dot agrees with the day it opens and with that day's calendar dot, which
    // /glance/calendar re-judges from its own rounded numbers the same way.
    strip: figure.strip.map((day) => {
      const dayValue = roundMetricValueOrNull(metric, day.value)
      const dayBand = roundBand(metric, day.band)
      const dayStanding = standingOf(dayValue, dayBand, figure.partial && day.localDate === ownDate)
      return { ...day, value: dayValue, band: dayBand, standing: dayStanding, judged: judge(dayStanding, direction) }
    }),
    standing,
    judged: judge(standing, direction),
  }
}

/** `value` to `precision` decimals, the same toFixed rule roundMetricValue applies with a catalogue precision. */
function roundTo(precision: number, value: number): number {
  return Number(value.toFixed(precision))
}

function roundToOrNull(precision: number, value: number | null): number | null {
  return value === null ? null : roundTo(precision, value)
}

function roundBandTo(precision: number, band: GlanceBaseline | null): GlanceBaseline | null {
  return band === null ? null : {
    ...band, center: roundTo(precision, band.center), low: roundTo(precision, band.low), high: roundTo(precision, band.high),
  }
}

/**
 * The verdict a rounded value and band support. Kept null where core said null: rounding never
 * turns a value or a band null or a band thin, so core's null means one of those or a partial day
 * (the workout page's own day's steps while that day is still running), which a PageFigure does
 * not carry for this to recompute. Otherwise `standingOf` on the rounded pair, partial false.
 */
function standingAfterRounding(
  before: GlanceStanding | null, value: number | null, band: GlanceBaseline | null,
): GlanceStanding | null {
  return before === null ? null : standingOf(value, band, false)
}

/**
 * A detail page's figure at its own `precision`, never METRICS[figure.metric]'s: the night page's
 * summary figures (sleep_latency_minutes and the rest) are not catalogue metrics, and a workout
 * figure's metric is its key ('pace'). Standing and then `judged` are recomputed from the rounded
 * value and band, in the order roundFigure uses, so "400, below your usual 400" cannot be sent.
 * Each strip day is rounded and re-judged against its own rounded band the same way.
 */
export function roundPageFigure(figure: PageFigure): PageFigure {
  const { precision } = figure
  const value = roundToOrNull(precision, figure.value)
  const baseline = roundBandTo(precision, figure.baseline)
  const standing = standingAfterRounding(figure.standing, value, baseline)
  return {
    ...figure,
    value,
    baseline,
    standing,
    judged: judge(standing, figure.direction),
    strip: figure.strip === null ? null : figure.strip.map((day) => {
      const dayValue = roundToOrNull(precision, day.value)
      const dayBand = roundBandTo(precision, day.band)
      const dayStanding = standingAfterRounding(day.standing, dayValue, dayBand)
      return { ...day, value: dayValue, band: dayBand, standing: dayStanding, judged: judge(dayStanding, figure.direction) }
    }),
  }
}

/** roundPageFigure's rule for a workout figure, whose strip is earlier sessions' bare values with no band or verdict of their own. */
export function roundWorkoutFigure(figure: WorkoutFigure): WorkoutFigure {
  const { precision } = figure
  const value = roundToOrNull(precision, figure.value)
  const baseline = roundBandTo(precision, figure.baseline)
  const standing = standingAfterRounding(figure.standing, value, baseline)
  return {
    ...figure,
    value,
    baseline,
    standing,
    judged: judge(standing, figure.direction),
    strip: figure.strip.map((point) => ({ ...point, value: roundToOrNull(precision, point.value) })),
  }
}

/**
 * registerV1's plugin wide guard has already refused this request unless :personId is the signed
 * in account's own person, so the path segment is the caller's person by the time a handler runs.
 * Read here rather than off personQuery, which keeps its person id private. Moved here from
 * annotations.ts (Task 3, M9c) so quickLog.ts can share it rather than carrying a second copy.
 */
export function personIdOf(request: FastifyRequest<{ Params: PersonParams }>): string {
  return request.params.personId
}

/**
 * A JSON body carries types a query string cannot, so a field can arrive as a number or an
 * object where a string was meant. Narrowed here and then handed to requireString, so a missing
 * field and an empty one refuse in the same words as everywhere else on this surface. Moved here
 * from annotations.ts (Task 3, M9c) so quickLog.ts can share it rather than carrying a second copy.
 */
export function textField(value: unknown, name: string): string {
  if (value !== undefined && typeof value !== 'string') throw new ConfigError(`${name} must be a string`)
  return requireString(value, name)
}

/**
 * `from` and `to` both present, both real calendar dates, and not reversed. Shared by /notes,
 * /events and quickLog.ts's /moods, the reads a caller ranges by local date, so the refusal a
 * caller sees for a malformed or backwards range cannot drift between them. Moved here from
 * annotations.ts (Task 3, M9c) for the same reason personIdOf and textField were.
 */
export function requireDateRange(query: DateRangeQuery): { from: string, to: string } {
  const from = requireString(query.from, 'from')
  const to = requireString(query.to, 'to')
  requireDate('from', from)
  requireDate('to', to)
  if (from > to) throw new ConfigError(`from '${from}' is after to '${to}'`)
  return { from, to }
}
