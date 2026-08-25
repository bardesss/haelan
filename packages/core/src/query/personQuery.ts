import { and, asc, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { daily, SESSION_KINDS, sources } from '../db/schema/index.ts'
import { MERGED_SOURCE, PROVIDER_SOURCE } from '../derive/rollup.ts'
import { metricSpec } from '../derive/metrics.ts'
import { ConfigError } from '../errors.ts'
import { baselineOf, baselineWindow, BASELINE_WINDOW_DAYS } from './baseline.ts'
import type { Baseline } from './baseline.ts'
import { coverageIsMeaningful } from './coverageSignal.ts'
// Aliased: the class has a method of the same name, and an unqualified call inside it
// resolving to the module import rather than the method is technically fine and genuinely
// confusing to read.
import { comparePeriods as comparePeriodPoints, INSIGHT_MIN_COVERAGE } from './insights.ts'
import type { Insight, PeriodPoint } from './insights.ts'
import { shiftLocalDate } from '../derive/localDay.ts'
import { thin } from './downsample.ts'
import type { Thinned } from './downsample.ts'
import { readIntraday } from './intraday.ts'
import type { IntradayResult } from './intraday.ts'
import { readSleepNights } from './sleepNights.ts'
import type { Night } from './sleepNights.ts'
import { readSessions } from './sessions.ts'
import type { WorkoutSession } from './sessions.ts'
import { trendOf } from './trend.ts'
import type { TrendPoint } from './trend.ts'
import { readChanges } from './changes.ts'
import type { ChangesResult } from './changes.ts'

export interface DailyPoint {
  localDate: string
  value: number
  /** Null where there was never a basis to measure hours: a sleep row or a provider row. */
  coverage: number | null
  source: string
  sourceMix: string | null
  /**
   * When this row was last written. Null for a row derived before M3b added the column, and for
   * any row a rebuild has not touched since. The HTTP surface's conditional requests are the
   * reason this is here: an ETag over `daily` needs the newest stamp among the rows an answer
   * drew on, and there was no reader over the column anywhere in core until now.
   */
  updatedAtMs: number | null
}

export interface SeriesResult {
  points: DailyPoint[]
  reduction: Thinned<DailyPoint>['reduction']
}

/**
 * Everything a surface asks of the store, bound to one person at construction.
 *
 * Master design section 11 requires the binding to live here rather than in the callers, because
 * a tool that forgets a WHERE clause must not be able to leak another member's data. There is
 * deliberately no unbound variant and no optional person parameter: the guarantee is that you
 * cannot express the question without saying whose data it is about.
 *
 * Every method validates its own arguments and throws rather than returning an emptiness. The
 * direct consumers are an HTTP query string and a language model's tool arguments, and a query
 * that quietly returns nothing becomes an agent saying there is no data for that period, which
 * is a false statement about somebody's health record made with total confidence.
 */
export class PersonQuery {
  readonly #db: DbOrTx

  readonly #personId: string

  constructor(db: DbOrTx, personId: string) {
    this.#db = db
    this.#personId = personId
  }

  /**
   * The daily rows for a metric over an inclusive range, oldest first.
   *
   * With no `source`, this answers what happened that day: the merged row where we reconciled
   * one, and the provider row where Google already had. Both mean the day rather than one
   * device, which is what `daily.source`'s own column comment says they differ only in who
   * reconciled. Passing a source id reads that device instead, which is what keeps a merge
   * inspectable against the rows underneath it, and passing `merged` still means only the rows
   * we merged ourselves.
   */
  series(input: {
    metric: string
    agg: string
    from: string
    to: string
    source?: string
    points?: number
  }): SeriesResult {
    requireMetricAndAgg(input.metric, input.agg)
    requireRange(input.from, input.to)
    requireSource(this.#db, this.#personId, input.source, DERIVED_SOURCES)

    const source = input.source
    const rows = this.#db.select({
      localDate: daily.localDate,
      value: daily.value,
      coverage: daily.coverage,
      source: daily.source,
      sourceMix: daily.sourceMix,
      updatedAtMs: daily.updatedAtMs,
    }).from(daily).where(and(
      eq(daily.personId, this.#personId),
      eq(daily.metric, input.metric),
      eq(daily.agg, input.agg),
      source === undefined
        ? inArray(daily.source, [MERGED_SOURCE, PROVIDER_SOURCE])
        : eq(daily.source, source),
      gte(daily.localDate, input.from),
      lte(daily.localDate, input.to),
      // A row with no value is not a measurement, and letting one through would put a hole in
      // every mean computed downstream. Nothing writes one today; this is the guard for later.
      isNotNull(daily.value),
    )).orderBy(asc(daily.localDate)).all() as DailyPoint[]

    const result = source === undefined ? preferMerged(rows) : rows
    if (input.points === undefined) return { points: result, reduction: null }

    // Daily rows are evenly spaced by construction, one per local date, so the index is the
    // correct x to thin on. Parsing each localDate back into an instant would buy nothing and
    // add a timezone question this series does not have.
    const indexed = result.map((point, index) => ({ index, point }))
    const thinned = thin(indexed, input.points, {
      method: 'lttb',
      x: (entry) => entry.index,
      y: (entry) => entry.point.value,
    })
    return { points: thinned.points.map((entry) => entry.point), reduction: thinned.reduction }
  }

  /**
   * The person's own baseline for a metric as of a date.
   *
   * The window ends the day BEFORE `on`, so a reading is never part of the baseline it is
   * judged against. Including it pulls the centre toward itself and biases its own z score
   * toward zero, and the bias is largest exactly when history is shortest.
   */
  baseline(input: {
    metric: string
    agg: string
    on: string
    windowDays?: number
    source?: string
  }): Baseline | null {
    requireMetricAndAgg(input.metric, input.agg)
    requireDate('on', input.on)
    requireSource(this.#db, this.#personId, input.source, DERIVED_SOURCES)

    const windowDays = input.windowDays ?? BASELINE_WINDOW_DAYS
    requirePositiveInteger('windowDays', windowDays)
    const { from, to } = baselineWindow(input.on, windowDays)
    const { points } = this.series({
      metric: input.metric, agg: input.agg, from, to, source: input.source,
    })

    // A barely observed day is a systematic undercount, not a low reading, and sixty of them
    // build a centre a properly worn day then scores a large z against. The insight gate refuses
    // such a period outright; a baseline can do better and drop the days rather than the answer.
    const judgeCoverage = coverageIsMeaningful(input.metric)
    const values = points
      .filter((point) => !(judgeCoverage && point.coverage !== null && point.coverage < INSIGHT_MIN_COVERAGE))
      .map((point) => point.value)

    return baselineOf(values, windowDays)
  }

  /**
   * A range against the range of equal length immediately before it. Suppression is the pure
   * function's decision; this only fetches the two periods, says how long they are, and says
   * whether coverage means anything for this metric.
   */
  comparePeriods(input: {
    metric: string
    agg: string
    from: string
    to: string
    source?: string
  }): Insight {
    requireMetricAndAgg(input.metric, input.agg)
    requireRange(input.from, input.to)
    requireSource(this.#db, this.#personId, input.source, DERIVED_SOURCES)

    const periodDays = daysBetween(input.from, input.to)
    const previousTo = shiftLocalDate(input.from, -1)
    const previousFrom = shiftLocalDate(previousTo, -(periodDays - 1))

    // The comparison period is derived here, never supplied. Stepping a wide range back by its
    // own length lands outside the calendar, and the ConfigError series() then threw named a date
    // the caller had never written: `from must be a YYYY-MM-DD local date, got '-008000-01'` in
    // answer to a request that said 1000-01-01. Whoever read that had a range to go and find in
    // their own code that was not in it. Refused here instead, in terms of what was passed, and
    // saying where the range the message does not name came from.
    if (!ISO_DATE.test(previousFrom) || !ISO_DATE.test(previousTo)) {
      throw new ConfigError(
        `from '${input.from}' to '${input.to}' spans ${periodDays} days, and the period of equal `
        + 'length immediately before it, which is what this compares against, starts before year 0001',
      )
    }

    // Coverage is a fraction of the day's hours, so a once-a-day metric reads 0.0417 when it is
    // perfect. Handing that number to a gate built for continuously sampled data suppresses the
    // whole Recovery page forever. Null says the period cannot be judged on coverage, which the
    // gate already handles correctly.
    const judgeCoverage = coverageIsMeaningful(input.metric)
    const fetch = (from: string, to: string): PeriodPoint[] => this.series({
      metric: input.metric, agg: input.agg, from, to, source: input.source,
    }).points.map((point) => ({
      localDate: point.localDate,
      value: point.value,
      coverage: judgeCoverage ? point.coverage : null,
    }))

    const insight = comparePeriodPoints({
      current: fetch(input.from, input.to),
      previous: fetch(previousFrom, previousTo),
      periodDays,
    })

    return {
      ...insight,
      currentRange: { from: input.from, to: input.to },
      previousRange: { from: previousFrom, to: previousTo },
    }
  }

  /**
   * One day of per-minute samples for a metric, pivoted onto one row per minute per source and
   * thinned for a chart. See `readIntraday` for why source is never chosen for the caller.
   */
  intraday(input: {
    metric: string
    localDate: string
    points?: number
    sourceId?: string
  }): IntradayResult {
    requireMetric(input.metric)
    requireDate('localDate', input.localDate)
    requireSource(this.#db, this.#personId, input.sourceId, [])
    return readIntraday(this.#db, {
      personId: this.#personId,
      metric: input.metric,
      localDate: input.localDate,
      points: input.points,
      sourceId: input.sourceId,
    })
  }

  /** The person's sleep nights in a local date range. See `readSleepNights` for the grouping. */
  sleepNights(input: {
    from: string
    to: string
    sourceId?: string
  }): Night[] {
    requireRange(input.from, input.to)
    requireSource(this.#db, this.#personId, input.sourceId, [])
    return readSleepNights(this.#db, {
      personId: this.#personId,
      from: input.from,
      to: input.to,
      sourceId: input.sourceId,
    })
  }

  /** Sessions of one kind in a local date range. See `readSessions` for why kind is load bearing. */
  sessions(input: {
    kind: 'sleep' | 'exercise'
    from: string
    to: string
    sourceId?: string
  }): WorkoutSession[] {
    requireSessionKind(input.kind)
    requireRange(input.from, input.to)
    requireSource(this.#db, this.#personId, input.sourceId, [])
    return readSessions(this.#db, {
      personId: this.#personId,
      kind: input.kind,
      from: input.from,
      to: input.to,
      sourceId: input.sourceId,
    })
  }

  /**
   * A smoothed line over the daily series. Days with no row are absent from the input to
   * `trendOf` rather than zero, the same treatment `series` already gives a day with no data.
   */
  trend(input: {
    metric: string
    agg: string
    from: string
    to: string
    source?: string
  }): TrendPoint[] {
    requireMetricAndAgg(input.metric, input.agg)
    requireRange(input.from, input.to)
    requireSource(this.#db, this.#personId, input.source, DERIVED_SOURCES)

    const { points } = this.series({
      metric: input.metric, agg: input.agg, from: input.from, to: input.to, source: input.source,
    })
    const byDate = new Map(points.map((point) => [point.localDate, point.value]))

    const days = daysBetween(input.from, input.to)
    const withGaps = Array.from({ length: days }, (_, i) => {
      const localDate = shiftLocalDate(input.from, i)
      return { localDate, value: byDate.get(localDate) ?? null }
    })

    return trendOf(withGaps)
  }

  /**
   * The (localDate, metric) pairs whose derived rows moved after `since`. See readChanges for
   * why the pairs are distinct rather than one per row, why a rebuild's whole-history answer is
   * correct rather than a bug, and why provider rows are in scope.
   */
  changes(input: {
    since: number
    limit?: number
    cursor?: string
  }): ChangesResult {
    requireFiniteNumber('since', input.since)
    if (input.limit !== undefined) requirePositiveInteger('limit', input.limit)
    return readChanges(this.#db, {
      personId: this.#personId,
      since: input.since,
      limit: input.limit,
      cursor: input.cursor,
    })
  }
}

/**
 * One row per day, preferring the one we reconciled. Per row rather than per series, because a
 * single stray merged row must not hide an entire provider series, and a metric can gain a
 * merged row partway through its history the day a second device starts reporting it.
 */
function preferMerged(rows: readonly DailyPoint[]): DailyPoint[] {
  const byDate = new Map<string, DailyPoint>()
  for (const row of rows) {
    if (!byDate.has(row.localDate) || row.source === MERGED_SOURCE) byDate.set(row.localDate, row)
  }
  // Map iteration follows insertion, and the rows arrived ordered, so this stays oldest first.
  return [...byDate.values()]
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The column holds ISO dates and every comparison against it is a string comparison, so an
 * unpadded '2026-8-1' does not just sort oddly, it silently excludes the whole month.
 */
function requireDate(label: string, value: string): void {
  if (!ISO_DATE.test(value)) {
    throw new ConfigError(`${label} must be a YYYY-MM-DD local date, got '${value}'`)
  }
  // The shape alone accepts a thirteenth month and a thirtieth of February, and those diverge
  // rather than fail together: series compares them as strings and finds nothing, while the two
  // methods that step dates hand them to Date.parse and throw from three frames down. Round
  // tripping through the calendar is what refuses a date that cannot exist while keeping a real
  // leap day, and it makes all three methods refuse the same input the same way.
  const onCalendar = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(onCalendar.getTime()) || onCalendar.toISOString().slice(0, 10) !== value) {
    throw new ConfigError(`${label} is not a date on the calendar, got '${value}'`)
  }
}

function requireRange(from: string, to: string): void {
  requireDate('from', from)
  requireDate('to', to)
  if (from > to) throw new ConfigError(`from '${from}' is after to '${to}'`)
}

/**
 * windowDays: 0 used to compute a `from` after `to` and throw a ConfigError naming the two dates
 * instead of the argument that was actually wrong. Reaching zero or negative days back is not a
 * range problem, it is this argument, so this is what the message has to name.
 */
function requirePositiveInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer, got ${value}`)
  }
}

/**
 * `since` reaches PersonQuery from an HTTP query string and a language model's tool arguments,
 * neither of which the type system protects: a value that failed to parse to a number arrives
 * here as NaN rather than being caught on the way in.
 */
function requireFiniteNumber(label: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${label} must be a number, got ${value}`)
  }
}

/** The catalogue decides which aggregates a metric has. Summing heart rate is not an answer. */
function requireMetricAndAgg(metric: string, agg: string): void {
  const spec = metricSpec(metric)
  if (spec === undefined) throw new ConfigError(`no metric named '${metric}'`)
  if (!(spec.aggs as readonly string[]).includes(agg)) {
    throw new ConfigError(`metric '${metric}' has no '${agg}' aggregate, only ${spec.aggs.join(', ')}`)
  }
}

/**
 * `intraday` has no aggregate to validate against, since it reads samples directly rather than a
 * `daily` row, but the metric itself still needs the same refusal `requireMetricAndAgg` gives
 * every other reader: a typo left unvalidated answers with an empty result, indistinguishable
 * from "this person has no data".
 */
function requireMetric(metric: string): void {
  if (metricSpec(metric) === undefined) throw new ConfigError(`no metric named '${metric}'`)
}

/**
 * The two `daily.source` values that are not a source id at all. See rollup.ts for what each
 * means and why they are kept apart from one another.
 */
const DERIVED_SOURCES: readonly string[] = [MERGED_SOURCE, PROVIDER_SOURCE]

/**
 * The same refusal `requireMetric` gives a metric, for the one parameter that was still answering
 * a typo with an empty result: every read that takes a source narrowed to it with an equality
 * test, so an id nobody has matched no row and came back as 200 with nothing, indistinguishable
 * from "this person has no data" for the range asked for.
 *
 * Validated against `sources`, the registry of what this person actually has, rather than against
 * the distinct values present in the table being read: a device that reported nothing on the days
 * asked for is a real source with an empty answer, and refusing it would turn a true empty result
 * into an error. `alsoAllowed` carries the `daily` backed reads' two extra values, which name a
 * merge rather than a device and so appear in no registry.
 *
 * The listing is the person's own source ids, which a caller holding a PersonQuery is already
 * bound to by construction, so it discloses nothing the same caller cannot read from `/sources`.
 */
function requireSource(
  db: DbOrTx, personId: string, source: string | undefined, alsoAllowed: readonly string[],
): void {
  if (source === undefined) return
  // Ordered, so two identical requests cannot produce two different messages.
  const registered = db.select({ id: sources.id }).from(sources)
    .where(eq(sources.personId, personId)).orderBy(asc(sources.id)).all().map((row) => row.id)
  const known = [...registered, ...alsoAllowed]
  if (known.includes(source)) return
  throw new ConfigError(known.length === 0
    ? `no source named '${source}', and this person has no sources at all`
    : `no source named '${source}', only ${known.join(', ')}`)
}

/**
 * `sessions({ kind })` is typed as `'sleep' | 'exercise'`, but the type system only protects a
 * caller written in TypeScript. The two real consumers, an HTTP query string and a language
 * model's tool arguments, sit outside it, so a value the type forbids still has to be refused at
 * runtime rather than read as a kind that matches no row and called an empty answer.
 */
function requireSessionKind(kind: string): void {
  if (!(SESSION_KINDS as readonly string[]).includes(kind)) {
    throw new ConfigError(`kind must be one of ${SESSION_KINDS.join(', ')}, got '${kind}'`)
  }
}

const DAY_MS = 86_400_000

/**
 * Inclusive, so a range from a date to itself is one day. Local dates carry no zone, so
 * parsing them as UTC midnights is exact and a daylight saving change never moves a date.
 */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}
