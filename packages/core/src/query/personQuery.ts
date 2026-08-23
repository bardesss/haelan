import { and, asc, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { daily } from '../db/schema/index.ts'
import { MERGED_SOURCE, PROVIDER_SOURCE } from '../derive/rollup.ts'
import { baselineOf, BASELINE_WINDOW_DAYS } from './baseline.ts'
import type { Baseline } from './baseline.ts'
import { coverageIsMeaningful } from './coverageSignal.ts'
// Aliased: the class has a method of the same name, and an unqualified call inside it
// resolving to the module import rather than the method is technically fine and genuinely
// confusing to read.
import { comparePeriods as comparePeriodPoints, INSIGHT_MIN_COVERAGE } from './insights.ts'
import type { Insight, PeriodPoint } from './insights.ts'
import { shiftLocalDate } from '../derive/localDay.ts'

export interface DailyPoint {
  localDate: string
  value: number
  /** Null where there was never a basis to measure hours: a sleep row or a provider row. */
  coverage: number | null
  source: string
  sourceMix: string | null
}

/**
 * Everything a surface asks of the store, bound to one person at construction.
 *
 * Master design section 11 requires the binding to live here rather than in the callers, because
 * a tool that forgets a WHERE clause must not be able to leak another member's data. There is
 * deliberately no unbound variant and no optional person parameter: the guarantee is that you
 * cannot express the question without saying whose data it is about.
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
  }): DailyPoint[] {
    const source = input.source
    const rows = this.#db.select({
      localDate: daily.localDate,
      value: daily.value,
      coverage: daily.coverage,
      source: daily.source,
      sourceMix: daily.sourceMix,
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

    return source === undefined ? preferMerged(rows) : rows
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
    const windowDays = input.windowDays ?? BASELINE_WINDOW_DAYS
    const to = shiftLocalDate(input.on, -1)
    const from = shiftLocalDate(to, -(windowDays - 1))
    const points = this.series({
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
    const periodDays = daysBetween(input.from, input.to)
    const previousTo = shiftLocalDate(input.from, -1)
    const previousFrom = shiftLocalDate(previousTo, -(periodDays - 1))

    // Coverage is a fraction of the day's hours, so a once-a-day metric reads 0.0417 when it is
    // perfect. Handing that number to a gate built for continuously sampled data suppresses the
    // whole Recovery page forever. Null says the period cannot be judged on coverage, which the
    // gate already handles correctly.
    const judgeCoverage = coverageIsMeaningful(input.metric)
    const fetch = (from: string, to: string): PeriodPoint[] => this.series({
      metric: input.metric, agg: input.agg, from, to, source: input.source,
    }).map((point) => ({
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

const DAY_MS = 86_400_000

/**
 * Inclusive, so a range from a date to itself is one day. Local dates carry no zone, so
 * parsing them as UTC midnights is exact and a daylight saving change never moves a date.
 */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}
